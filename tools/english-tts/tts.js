import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

const VOICE = {
	languageCode: "en-US",
	name: "en-US-Neural2-J",
	ssmlGender: "MALE",
};

const AUDIO_CONFIG = {
	audioEncoding: "MP3",
	speakingRate: 0.95,
	pitch: 0,
};

// Google TTS has a 5000 byte limit per request
const MAX_BYTES = 4800;

function splitTextIntoChunks(text) {
	const paragraphs = text.split(/\n\s*\n/);
	const chunks = [];
	let current = "";

	for (const paragraph of paragraphs) {
		const trimmed = paragraph.trim();
		if (!trimmed) continue;

		const combined = current ? `${current}\n\n${trimmed}` : trimmed;

		if (Buffer.byteLength(combined, "utf-8") > MAX_BYTES) {
			if (current) chunks.push(current);

			// If a single paragraph exceeds the limit, split by sentences
			if (Buffer.byteLength(trimmed, "utf-8") > MAX_BYTES) {
				const sentences = trimmed.match(/[^.!?]+[.!?]+\s*/g) || [trimmed];
				let sentenceChunk = "";
				for (const sentence of sentences) {
					const next = sentenceChunk ? sentenceChunk + sentence : sentence;
					if (Buffer.byteLength(next, "utf-8") > MAX_BYTES) {
						if (sentenceChunk) chunks.push(sentenceChunk.trim());
						sentenceChunk = sentence;
					} else {
						sentenceChunk = next;
					}
				}
				if (sentenceChunk) current = sentenceChunk.trim();
				else current = "";
			} else {
				current = trimmed;
			}
		} else {
			current = combined;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

async function synthesize(client, text) {
	const [response] = await client.synthesizeSpeech({
		input: { text },
		voice: VOICE,
		audioConfig: AUDIO_CONFIG,
	});
	return response.audioContent;
}

async function main() {
	const inputFile = process.argv[2];

	if (!inputFile) {
		console.error("Usage: node tts.js <input.txt> [output.mp3]");
		console.error("");
		console.error("Environment:");
		console.error(
			"  GOOGLE_APPLICATION_CREDENTIALS - Path to service account JSON",
		);
		console.error(
			"  GOOGLE_SERVICE_ACCOUNT         - Service account JSON string (alternative)",
		);
		process.exit(1);
	}

	// Support GOOGLE_SERVICE_ACCOUNT env var (JSON string) as alternative
	let clientOptions = {};
	if (process.env.GOOGLE_SERVICE_ACCOUNT) {
		const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
		clientOptions = { credentials };
	}

	const client = new TextToSpeechClient(clientOptions);

	const text = readFileSync(inputFile, "utf-8").trim();
	if (!text) {
		console.error("Error: Input file is empty");
		process.exit(1);
	}

	const outputDir = "output";
	if (!existsSync(outputDir)) {
		mkdirSync(outputDir);
	}

	const baseName = basename(inputFile, ".txt");
	const outputFile = process.argv[3] || join(outputDir, `${baseName}.mp3`);

	const chunks = splitTextIntoChunks(text);
	console.log(`Processing ${chunks.length} chunk(s) from "${inputFile}"...`);

	const audioBuffers = [];
	for (let i = 0; i < chunks.length; i++) {
		console.log(
			`  Synthesizing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`,
		);
		const audio = await synthesize(client, chunks[i]);
		audioBuffers.push(audio);
	}

	const combined = Buffer.concat(audioBuffers.map((b) => Buffer.from(b)));
	writeFileSync(outputFile, combined);
	console.log(`Done! Audio saved to: ${outputFile}`);
}

main().catch((err) => {
	console.error("Error:", err.message);
	process.exit(1);
});
