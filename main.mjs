import fs from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import OpenAI from "openai";
import dotenv from "dotenv";
dotenv.config();

const exec = promisify(execCb);

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 👉 PAS DEZE AAN NAAR JOUW BESTANDSNAAM
const inputFile = 'Jan Smit was achter de schermen helemaal niet aardig (1).mp3';

// Instellingen
const maxChunkSeconds = 1200;       // jouw wens: 1200s max per chunk (max 1400 sec sturen naar API)
const silenceSearchWindow = 180;     // rond de 1200s maximaal 180s naar voren/achter stilte zoeken
const noiseLevelDb = -36;           // hoe streng "stilte" is, -35dB is redelijk
const minSilenceDuration = 0.7;     // minimale duur van stilte in seconden

function formatTime(sec) {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

async function getDuration(file) {
  const cmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`;
  const { stdout } = await exec(cmd);
  const duration = parseFloat(stdout.trim());
  if (Number.isNaN(duration)) {
    throw new Error("Kon duur niet bepalen met ffprobe");
  }
  return duration;
}

async function detectSilences(file) {
  const cmd = `ffmpeg -i "${file}" -af silencedetect=noise=${noiseLevelDb}dB:d=${minSilenceDuration} -f null -`;
  // silencedetect logt naar stderr
  const { stderr } = await exec(cmd, { maxBuffer: 10 * 1024 * 1024 });
  const lines = stderr.split("\n");
  const silenceStarts = [];

  for (const line of lines) {
    const match = line.match(/silence_start:\s*([0-9.]+)/);
    if (match) {
      silenceStarts.push(parseFloat(match[1]));
    }
  }

  silenceStarts.sort((a, b) => a - b);
  return silenceStarts;
}

function chooseCutPoints(duration, silenceStarts, maxChunk, window) {
  const points = [0];
  let target = maxChunk;

  while (target < duration) {
    const from = target - window;
    const to = target + window;

    const candidates = silenceStarts.filter(
      (t) => t >= from && t <= to
    );

    let cut;
    if (candidates.length > 0) {
      // kies de stilte die het dichtst bij target ligt
      cut = candidates.reduce((prev, cur) =>
        Math.abs(cur - target) < Math.abs(prev - target) ? cur : prev
      );
    } else {
      // geen stilte in de buurt → gewoon hard op target knippen
      cut = target;
    }

    // vang rare gevallen op dat een chunk onverwacht veel groter wordt
    const lastPoint = points[points.length - 1];
    if (cut - lastPoint > maxChunk * 1.1) {
      cut = lastPoint + maxChunk;
    }

    if (cut >= duration) break;

    points.push(cut);
    target = cut + maxChunk;
  }

  if (points[points.length - 1] < duration) {
    points.push(duration);
  }

  return points;
}

async function splitFile(input, cutPoints) {
  const chunks = [];

  for (let i = 0; i < cutPoints.length - 1; i++) {
    const start = cutPoints[i];
    const end = cutPoints[i + 1];
    const outFile = `chunk_${i + 1}.mp3`;

    const cmd = `ffmpeg -y -i "${input}" -ss ${start} -to ${end} -c copy "${outFile}"`;
    console.log(`🎬 Knippen: ${formatTime(start)} - ${formatTime(end)} -> ${outFile}`);
    await exec(cmd, { maxBuffer: 10 * 1024 * 1024 });

    chunks.push({ file: outFile, start, end });
  }

  return chunks;
}

async function transcribeChunk(index, chunk) {
  const { file, start, end } = chunk;

  console.log(`🔊 Transcriberen chunk ${index + 1}: ${file} (${formatTime(start)} - ${formatTime(end)})`);

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(file),
    model: "gpt-4o-transcribe", // of jouw model, bv "gpt-4o-mini-transcribe"
    language: "nl",
    temperature: 0,
  });

  const text = response.text ?? String(response);
  const header = `\n\n=== Deel ${index + 1} (${formatTime(start)} - ${formatTime(end)}) ===\n\n`;
  return header + text.trim() + "\n";
}

async function main() {
  try {
    if (!fs.existsSync(inputFile)) {
      console.error(`Bestand niet gevonden: ${inputFile}`);
      process.exit(1);
    }

    console.log("⏱  Duur bepalen...");
    const duration = await getDuration(inputFile);
    console.log(`Totale duur: ${duration.toFixed(1)}s (${formatTime(duration)})`);

    console.log("🔎 Stiltes detecteren (kan even duren)...");
    const silenceStarts = await detectSilences(inputFile);
    console.log(`Gevonden stiltes op: ${silenceStarts.map((s) => s.toFixed(1)).join(", ") || "geen"}`);

    console.log("✂️  Cutpoints bepalen...");
    const cutPoints = chooseCutPoints(duration, silenceStarts, maxChunkSeconds, silenceSearchWindow);
    console.log("Cutpoints:", cutPoints.map((c) => formatTime(c)).join(" | "));

    console.log("🎬 Bestand in chunks knippen...");
    const chunks = await splitFile(inputFile, cutPoints);

    console.log("📝 Chunks transcriberen en samenvoegen...");
    let merged = "";

    for (let i = 0; i < chunks.length; i++) {
      const part = await transcribeChunk(i, chunks[i]);
      merged += part;
      // tussentijds opslaan (handig bij errors of onderbreking)
      fs.writeFileSync("transcript_merged.txt", merged, "utf8");
    }

    console.log("✅ Klaar! Samengevoegd transcript staat in: transcript_merged.txt");
  } catch (err) {
    console.error("❌ Er ging iets mis:");
    console.error(err);
    process.exit(1);
  }
}

main();
