// ---------------------------------------------------------------------------
// Call transcription — after Twilio finishes recording a browser call
// (dual-channel: advisor + customer), we download the audio server-side and
// transcribe it with OpenAI speech-to-text so the full two-party conversation
// is logged on the call record. Fire-and-forget; never throws into the
// webhook path. Twilio credentials never leave the server.
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import { db, callLogsTable } from "@workspace/db";
import { twilioVoiceConfig } from "./telephony";
import { autoAnalyzeCall } from "./call-analysis";
import { logger } from "./logger";

/** Download the recording audio (mp3) from Twilio using server credentials. */
export async function fetchRecordingAudio(
  recordingSid: string,
): Promise<Buffer | null> {
  const cfg = twilioVoiceConfig();
  if (!cfg) return null;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Recordings/${recordingSid}.mp3`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString(
    "base64",
  );
  const resp = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!resp.ok) {
    logger.warn(
      { recordingSid, status: resp.status },
      "Failed to download Twilio recording",
    );
    return null;
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function transcribe(callLogId: number): Promise<void> {
  const [call] = await db
    .select()
    .from(callLogsTable)
    .where(eq(callLogsTable.id, callLogId));
  if (!call?.recordingSid) return;

  const audio = await fetchRecordingAudio(call.recordingSid);
  if (!audio || audio.length === 0) {
    await db
      .update(callLogsTable)
      .set({ transcriptStatus: "failed" })
      .where(eq(callLogsTable.id, callLogId));
    return;
  }

  // Lazy import: the OpenAI integration module throws at load time when its
  // env vars are missing — that must degrade transcription, not API startup.
  const { speechToText } = await import(
    "@workspace/integrations-openai-ai-server/audio"
  );
  const text = (await speechToText(audio, "mp3")).trim();
  await db
    .update(callLogsTable)
    .set({
      transcript: text.length > 0 ? text : null,
      transcriptStatus: text.length > 0 ? "completed" : "failed",
    })
    .where(eq(callLogsTable.id, callLogId));

  // Re-run the sentiment/summary agent now that the real conversation exists.
  if (text.length > 0) autoAnalyzeCall(callLogId);
}

/** Fire-and-forget transcription of a completed recording. */
export function autoTranscribeCall(callLogId: number): void {
  transcribe(callLogId).catch(async (err) => {
    logger.error({ err, callLogId }, "Call transcription failed");
    await db
      .update(callLogsTable)
      .set({ transcriptStatus: "failed" })
      .where(eq(callLogsTable.id, callLogId))
      .catch?.(() => undefined);
  });
}
