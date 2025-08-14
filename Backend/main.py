import os
import tempfile
import subprocess
import logging
from openai import OpenAI, APIError
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict
import uvicorn
from dotenv import load_dotenv
from langdetect import detect, DetectorFactory

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

        # Force Whisper language
        whisper_lang = "hi" if selected_language.lower() == "hindi" else "en"

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

def generate_tts(text, language):
    # Select voice based on language
    voice = "alloy" if language == "en" else "nova" if language == "hi" else "alloy"
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
        raise HTTPException(status_code=400, detail=str(e))

from fastapi import Form

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

        language_code = "en" if request.language.lower() == "english" else "hi"
        speech_path = generate_tts(request.prompt, language_code)
        return FileResponse(speech_path, media_type="audio/wav", filename="response.wav")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)