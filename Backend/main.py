import os
import tempfile
import subprocess
import logging
import io
import base64
from openai import OpenAI, APIError
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Optional
import uvicorn
from dotenv import load_dotenv
from langdetect import detect, DetectorFactory
import PyPDF2
import docx
from PIL import Image
import pytesseract

# Ensure consistent language detection
DetectorFactory.seed = 0

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

load_dotenv()

DURATION = 5
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise ValueError("OPENAI_API_KEY environment variable is required")

print("OpenAI API key configured")
app = FastAPI()

# CORS setup
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# OpenAI client
openai_client = OpenAI(api_key=OPENAI_API_KEY)

class PromptRequest(BaseModel):
    prompt: str
    chat_history: List[Dict[str, str]] = []
    language: str = "english"  # default
    
class DocumentRequest(BaseModel):
    query: str
    documents: List[Dict]  # List of documents with content and metadata
    chat_history: List[Dict[str, str]] = []
    language: str = "english"

async def transcribe_audio(file: UploadFile, selected_language: str = "english"):
    # Save uploaded file
    with tempfile.NamedTemporaryFile(delete=False) as tmp_in:
        content = await file.read()
        tmp_in.write(content)
        tmp_in_path = tmp_in.name

    # Output WAV path
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_out:
        tmp_out_path = tmp_out.name

    try:
        # Convert to WAV (16kHz mono)
        subprocess.run([
            "ffmpeg", "-y", "-i", tmp_in_path, "-ar", "16000", "-ac", "1", tmp_out_path
        ], check=True)

        # whisper_lang = "hi" if selected_language.lower() == "hindi" else "en"
        # Force Whisper language
        lang = selected_language.lower()
        if lang == "hindi":
            whisper_lang = "hi"
        elif lang == "arabic":
            whisper_lang = "ar"
        else:
            whisper_lang = "en"


        with open(tmp_out_path, "rb") as audio_file:
            transcription = openai_client.audio.transcriptions.create(
                file=audio_file,
                model="whisper-1",
                language=whisper_lang,  # Force script
                response_format="verbose_json"
            )
        return transcription.text, transcription.language
    finally:
        os.remove(tmp_in_path)
        os.remove(tmp_out_path)


def get_ai_response(prompt, chat_history, model="gpt-4o-mini"):
    try:
        logger.debug("Received chat_history: %s", chat_history)
        messages = [{"role": "system", "content": "You are a helpful AI assistant. Use the full conversation history to respond in the same language as the user's prompt."}]
        
        # Filter chat history to only include 'ai' responses (not 'document')
        for chat in chat_history:
            if "user" in chat and "ai" in chat:
                messages.append({"role": "user", "content": chat["user"]})
                messages.append({"role": "assistant", "content": chat["ai"]})
        
        messages.append({"role": "user", "content": prompt})
        response = openai_client.chat.completions.create(model=model, messages=messages)
        return response.choices[0].message.content
    except APIError as e:
        logger.error("API Error: %s", str(e))
        raise HTTPException(status_code=400, detail=str(e))

def generate_tts(text, language_code):
    voice_map = {
        "en": "alloy",
        "hi": "alloy",  
        "ar": "alloy",  
    }
    voice = voice_map.get(language_code, "alloy")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
        speech_path = tmp_file.name
    try:
        response = openai_client.audio.speech.create(
            model="tts-1",
            voice=voice,
            input=text,
            response_format="wav"
        )
        with open(speech_path, "wb") as f:
            f.write(response.content)
        return speech_path
    except APIError as e:
        # Retry once with 'alloy' if some other voice was chosen
        if voice != "alloy":
            try:
                response = openai_client.audio.speech.create(
                    model="tts-1",
                    voice="alloy",
                    input=text,
                    response_format="wav"
                )
                with open(speech_path, "wb") as f:
                    f.write(response.content)
                return speech_path
            except APIError as e2:
                raise HTTPException(status_code=400, detail=f"TTS error: {str(e2)}")
        raise HTTPException(status_code=400, detail=f"TTS error: {str(e)}")

def extract_text_from_pdf(file_content):
    try:
        pdf_content = ""
        pdf_reader = PyPDF2.PdfReader(io.BytesIO(file_content))
        for page_num in range(len(pdf_reader.pages)):
            page = pdf_reader.pages[page_num]
            pdf_content += page.extract_text()
        return pdf_content
    except Exception as e:
        logger.error(f"Error extracting text from PDF: {str(e)}")
        raise Exception(f"Failed to extract text from PDF: {str(e)}")

def extract_text_from_docx(file_content):
    try:
        doc = docx.Document(io.BytesIO(file_content))
        return " ".join([paragraph.text for paragraph in doc.paragraphs])
    except Exception as e:
        logger.error(f"Error extracting text from DOCX: {str(e)}")
        raise Exception(f"Failed to extract text from DOCX: {str(e)}")

def extract_text_from_image(file_content):
    try:
        # Open image from bytes
        image = Image.open(io.BytesIO(file_content))
        
        # Convert to RGB if necessary (for PNG with transparency, etc.)
        if image.mode != 'RGB':
            image = image.convert('RGB')
        
        # Configure tesseract for better OCR
        custom_config = r'--oem 3 --psm 6 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+-=[]{}|;:,.<>?/~`" '
        
        # Extract text using OCR
        extracted_text = pytesseract.image_to_string(image, config=custom_config)
        
        # Clean up the extracted text
        extracted_text = extracted_text.strip()
        
        if not extracted_text:
            # Try with different PSM mode if first attempt fails
            custom_config = r'--oem 3 --psm 3'
            extracted_text = pytesseract.image_to_string(image, config=custom_config).strip()
        
        if not extracted_text:
            return "No text could be extracted from this image. The image might not contain readable text or the text might be too blurry/unclear for OCR processing."
            
        return extracted_text
        
    except Exception as e:
        logger.error(f"Error extracting text from image: {str(e)}")
        # Don't raise an exception, return a helpful message instead
        return f"Error processing image: Could not extract text from the image. Please ensure the image contains clear, readable text. Error details: {str(e)}"

def process_document(file: UploadFile) -> tuple:
    """
    Process document and return (text_content, is_image, image_base64)
    """
    try:
        # Read file content
        content = file.file.read()
        
        # Reset file pointer for potential re-reading
        file.file.seek(0)
        
        # Get file extension
        file_extension = file.filename.split(".")[-1].lower() if file.filename else ""
        
        logger.info(f"Processing file: {file.filename}, extension: {file_extension}, size: {len(content)} bytes")
        
        # Check if it's an image file
        is_image = file_extension in ["jpg", "jpeg", "png", "bmp", "tiff", "tif", "webp"]
        image_base64 = None
        
        if file_extension == "pdf":
            text_content = extract_text_from_pdf(content)
        elif file_extension in ["docx", "doc"]:
            text_content = extract_text_from_docx(content)
        elif is_image:
            # For images, extract text via OCR but also store the image data
            text_content = extract_text_from_image(content)
            # Convert image to base64 for vision API
            image_base64 = base64.b64encode(content).decode('utf-8')
        elif file_extension in ["txt"]:
            # Handle text files
            try:
                text_content = content.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    text_content = content.decode("latin-1")
                except UnicodeDecodeError:
                    text_content = content.decode("utf-8", errors="ignore")
        else:
            # For unsupported files, attempt text extraction as fallback
            try:
                text_content = content.decode("utf-8", errors="ignore")
            except Exception:
                raise Exception(f"Unsupported file format: {file_extension}")
        
        return text_content, is_image, image_base64
                
    except Exception as e:
        logger.error(f"Error processing document: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Cannot process this document: {str(e)}")

def get_language_name(language_code):
    """Convert language code to full name for better prompts"""
    language_map = {
        "english": "English",
        "hindi": "Hindi",
        "arabic": "Arabic"
    }
    return language_map.get(language_code.lower(), "English")

def is_meaningful_query(query):
    """
    Check if the query is meaningful and not just gibberish or very short unclear text
    """
    query = query.strip().lower()
    
    # Check if query is too short and doesn't contain meaningful words
    if len(query) <= 2:
        return False
    
    # List of common gibberish patterns or very unclear single words
    gibberish_patterns = [
        'otay', 'emjgr', 'thik', 'hmm', 'uhh', 'umm', 'err', 'ahh', 'ohh',
        'xyz', 'abc', 'qwe', 'asd', 'zxc', 'dfg', 'hjk', 'vbn', 'mnb',
        'test', 'testing', '123', 'hello', 'hi', 'hey'
    ]
    
    # Check if query is just gibberish
    if query in gibberish_patterns:
        return False
    
    # Check if query has at least one vowel (basic language structure check)
    vowels = 'aeiou'
    if not any(vowel in query for vowel in vowels) and len(query) > 2:
        # Allow some exceptions for valid consonant-only words
        valid_consonant_words = ['by', 'my', 'try', 'why', 'sky', 'dry', 'fly', 'cry']
        if query not in valid_consonant_words:
            return False
    
    # Check for random character sequences (more than 3 consecutive consonants)
    consonants = 'bcdfghjklmnpqrstvwxyz'
    consonant_count = 0
    for char in query:
        if char in consonants:
            consonant_count += 1
            if consonant_count > 3:
                return False
        else:
            consonant_count = 0
    
    return True

def get_ai_response_from_documents(query, documents, chat_history=None, model="gpt-4o-mini", language="english"):
    """
    Function to handle queries across multiple documents
    """
    try:
        if chat_history is None:
            chat_history = []
        
        # Check if the query is meaningful
        if not is_meaningful_query(query):
            language_name = get_language_name(language)
            if language_name == "Hindi":
                return "कृपया अपना प्रश्न स्पष्ट रूप से पूछें। आपका प्रश्न समझ में नहीं आया। कृपया दस्तावेज़ के बारे में कोई स्पष्ट प्रश्न पूछें।"
            elif language_name == "Arabic":
                return "يرجى توضيح سؤالك. لم أفهم استفسارك. يرجى طرح سؤال واضح حول الوثيقة."
            else:
                return "Please clarify your question. I didn't understand your query. Please ask a clear question about the document(s)."
        
        # Get the full language name for better prompts
        language_name = get_language_name(language)
        
        # Build consolidated document content
        consolidated_content = ""
        has_images = False
        image_contents = []
        
        for i, doc in enumerate(documents, 1):
            filename = doc.get("filename", f"Document {i}")
            content = doc.get("content", "")
            is_image = doc.get("is_image", False)
            image_data = doc.get("image_data")
            
            if is_image and image_data:
                has_images = True
                image_contents.append({
                    "filename": filename,
                    "content": content,
                    "image_data": image_data
                })
            
            consolidated_content += f"\n\n=== {filename} ===\n{content}"
        
        # Build messages array
        messages = []
        
        if has_images:
            # Use vision model for handling images
            model = "gpt-4o-mini"
            
            system_prompt = f"""You are a multi-document analysis assistant. You can analyze both text documents and images. Your job is to answer questions based STRICTLY on the provided documents.

CRITICAL RULES:
1. RESPOND ONLY IN {language_name.upper()} - This is mandatory regardless of what language appears in the documents
2. ONLY use information from the provided documents (text and images)
3. When referencing information, mention which document it comes from
4. If the documents don't contain the requested information, clearly state: "The documents do not contain information about [topic]" (translate this message to {language_name})
5. For image content, only describe what you can directly observe
6. Never provide general knowledge or information from outside the documents
7. Always respond in {language_name}
8. If a query is unclear, vague, or doesn't make sense in the context of the documents, ask for clarification in {language_name}
9. Do NOT provide previous responses or generic answers for unclear queries

Available Documents:
{consolidated_content}

Remember: Answer ONLY from the provided documents and ALWAYS respond in {language_name}. If the query is unclear or not related to the document content, ask for a clearer question."""

            messages.append({"role": "system", "content": system_prompt})
            
            # Filter chat history to only include 'document' responses
            for chat in chat_history:
                if "user" in chat and "document" in chat:
                    messages.append({"role": "user", "content": chat["user"]})
                    messages.append({"role": "assistant", "content": chat["document"]})
            
            # Add the current query with images
            user_content = [{"type": "text", "text": f"Please respond in {language_name}. {query}"}]
            
            # Add images to the message
            for img in image_contents:
                user_content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:image/jpeg;base64,{img['image_data']}"
                    }
                })
            
            messages.append({"role": "user", "content": user_content})
            
        else:
            # Text-only documents
            system_prompt = f"""You are a multi-document analysis assistant. Your ONLY job is to answer questions based STRICTLY on the provided documents.

CRITICAL RULES:
1. RESPOND ONLY IN {language_name.upper()} - This is mandatory regardless of what language the documents are written in
2. ONLY use information from the provided documents
3. When referencing information, mention which document it comes from (e.g., "According to [filename]...")
4. If the documents don't contain the requested information, clearly state: "The documents do not contain information about [topic]" (translate this message to {language_name})
5. Never provide general knowledge or information from outside the documents
6. Always quote or reference specific parts of the documents when answering
7. Always respond in {language_name}
8. If a query is unclear, vague, or doesn't make sense in the context of the documents, ask for clarification in {language_name}
9. Do NOT provide previous responses or generic answers for unclear queries
10. If the user's question seems to be gibberish or completely unrelated to the document content, politely ask them to rephrase their question

Available Documents:
{consolidated_content}

Remember: Answer ONLY from these documents and ALWAYS respond in {language_name}. If information is not in any document, say so clearly in {language_name}. If the query is unclear or seems meaningless, ask for clarification."""

            messages.append({"role": "system", "content": system_prompt})
            
            # Filter chat history to only include 'document' responses
            for chat in chat_history:
                if "user" in chat and "document" in chat:
                    messages.append({"role": "user", "content": chat["user"]})
                    messages.append({"role": "assistant", "content": chat["document"]})
            
            # Add the current query with language instruction
            messages.append({"role": "user", "content": f"Please respond in {language_name}. {query}"})
        
        response = openai_client.chat.completions.create(model=model, messages=messages, max_tokens=2000)
        return response.choices[0].message.content
        
    except APIError as e:
        logger.error(f"API Error: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))

from fastapi import Form

# List of generic acknowledgments and unclear expressions
GENERIC_ACKS = [
    'ok', 'okay', 'thank you', 'thanks', 'thx', 'k', 'kk', 'cool', 'great', 'nice', 'alright', 'sure', 'fine', 'noted', 'got it', 'roger', 'yup', 'yes', 'ya', 'yaar', 'acha', 'shukriya', 'dhanyavad', 'done', 'welcome', 'no', 'bye', 'see you', 'see ya', 'goodbye', 'good bye', 'ciao', 'tata', 'tc', 'take care', 'hmm', 'uhh', 'umm', 'err', 'ahh', 'ohh'
]

def is_generic_ack(text):
    normalized = text.strip().lower()
    return any(normalized == ack or normalized.startswith(ack + ' ') for ack in GENERIC_ACKS)

@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    language: str = Form("english")  # default English
):
    print("Using OpenAI API for transcription")
    try:
        text, detected_language = await transcribe_audio(file, language)
        if not text.strip():
            raise HTTPException(status_code=400, detail="Transcription is empty")
        return {"transcription": text, "language": detected_language}
    except APIError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    

@app.post("/generate_response")
async def generate_response_endpoint(request: PromptRequest):
    try:
        if not request.prompt.strip():
            raise HTTPException(status_code=422, detail="Prompt cannot be empty")
        
        # Force AI to respond in the chosen language
        language_instruction = f"Respond ONLY in {request.language}. Do not switch languages."
        ai_text = get_ai_response(f"{language_instruction}\n{request.prompt}", request.chat_history)
        
        return {"response": ai_text, "language": request.language}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/tts")
async def tts_endpoint(request: PromptRequest):
    try:
        if not request.prompt.strip():
            raise HTTPException(status_code=422, detail="Text cannot be empty")

        lang_lower = request.language.lower()
        if lang_lower == "english":
            language_code = "en"
        elif lang_lower == "hindi":
            language_code = "hi"
        elif lang_lower == "arabic":   # NEW
            language_code = "ar"
        else:
            language_code = "en"

        speech_path = generate_tts(request.prompt, language_code)
        return FileResponse(speech_path, media_type="audio/wav", filename="response.wav")
    except HTTPException as e:
        # keep the original status (avoid turning 400 into 500)
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/upload_documents")
async def upload_documents_endpoint(
    files: List[UploadFile] = File(...),
    query: str = Form(""),
    language: str = Form("english"),
    chat_history: str = Form("[]")  # JSON string of chat history
):
    try:
        import json
        # Parse chat history from string
        chat_history_parsed = json.loads(chat_history)

        processed_documents = []

        # Process each document
        for file in files:
            logger.info(f"Processing file: {file.filename}, content_type: {file.content_type}")

            try:
                # Extract text from document and check if it's an image
                document_text, is_image, image_base64 = process_document(file)

                if not document_text.strip() and not is_image:
                    logger.warning(f"Could not extract text from {file.filename}")
                    continue

                processed_documents.append({
                    "filename": file.filename,
                    "content": document_text,
                    "is_image": is_image,
                    "image_data": image_base64,
                    "text_length": len(document_text)
                })

                logger.info(f"Successfully processed {file.filename}: {len(document_text)} characters, is_image: {is_image}")

            except Exception as e:
                logger.error(f"Error processing {file.filename}: {str(e)}")
                continue

        if not processed_documents:
            raise HTTPException(status_code=400, detail="Could not process any of the uploaded documents")

        # If there's a query, get AI response from all documents
        if query.strip():
            if is_generic_ack(query):
                ai_response = "Let me know if you have a question about the document(s)."
            else:
                ai_response = get_ai_response_from_documents(
                    query,
                    processed_documents,
                    chat_history_parsed,
                    language=language
                )
            return {
                "success": True,
                "documents": processed_documents,
                "response": ai_response,
                "language": language,
                "document_count": len(processed_documents)
            }
        else:
            # Just return processed documents if no query
            return {
                "success": True,
                "documents": processed_documents,
                "response": f"Successfully processed {len(processed_documents)} document(s). You can ask questions about them now.",
                "language": language,
                "document_count": len(processed_documents)
            }

    except Exception as e:
        logger.error(f"Error in upload_multiple_documents: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/query_documents")
async def query_documents_endpoint(request: DocumentRequest):
    try:
        if not request.query.strip() or not request.documents:
            raise HTTPException(status_code=422, detail="Query and documents cannot be empty")

        if is_generic_ack(request.query):
            ai_response = "Let me know if you have a question about the document(s)."
        else:
            ai_response = get_ai_response_from_documents(
                request.query,
                request.documents,
                request.chat_history,
                language=request.language
            )

        return {"response": ai_response, "language": request.language}
    except Exception as e:
        logger.error(f"Error in query_documents: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)





