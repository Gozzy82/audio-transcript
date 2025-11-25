import fs from "fs";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "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",
});

async function transcribe() {
  try {
    const filePath = "jan-smit-deel2.mp3";

    // Check of bestand bestaat
    if (!fs.existsSync(filePath)) {
      console.error(`Bestand niet gevonden: ${filePath}`);
      process.exit(1);
    }

    console.log("🔊 Bezig met uploaden en transcriberen...");

    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-transcribe", // Whisper-achtig model voor transcriptie
      // Je kunt eventueel extra opties meegeven:
      language: "nl",
      temperature: 0,
    });

    const transcript = response.text ?? response;

// Transcript wegschrijven naar bestand
    const outputFile = "transcript.txt";
    fs.writeFileSync(outputFile, transcript, "utf8");

    console.log("✅ Klaar! Transcript opgeslagen in:", outputFile);
  } catch (err) {
    console.error("❌ Er ging iets mis tijdens het transcriberen:");
    console.error(err);
  }
}

transcribe();
