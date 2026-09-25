import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import input from 'input';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import OpenAI from 'openai';
import { createAnalyzer, loadAnalysisConfig } from './analysis-engine.js';
import { createCommandHandler } from './command-handler.js';
import { DeliveryState, writePrivateJson } from './private-state.js';

process.chdir(path.dirname(fileURLToPath(import.meta.url)));
process.umask(0o077);
dotenv.config({ quiet: true });
const runtimeDir = '.analysis-cache';
const sessionFile = '.telegram-session';
fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
fs.chmodSync(runtimeDir, 0o700);
const statusFile = path.join(runtimeDir, 'status.json');
const lockFile = path.join(runtimeDir, 'process.pid');
let ownsLock = false;
let client;
let runtime = {};
function updateStatus(patch) {
  runtime = { ...runtime, ...patch, updatedAt: new Date().toISOString() };
  writePrivateJson(statusFile, runtime);
}
function codeOf(error) {
  return String(error?.code || error?.name || 'ERROR').replace(/[^A-Z_a-z0-9-]/g, '').slice(0,70);
}
function acquireLock() {
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    let alive = Number.isInteger(pid) && pid > 0;
    if (alive) {
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) throw Object.assign(new Error(), { code: 'ALREADY_RUNNING' });
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600, flag: 'wx' });
  ownsLock = true;
}
async function stop() {
  if (ownsLock) {
    updateStatus({ stage: 'stopped' });
    if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
    ownsLock = false;
  }
  try { if (client) await client.disconnect(); } catch {}
  process.exit(0);
}
async function main() {
  const apiId = Number(process.env.TG_API_ID || 0);
  const apiHash = process.env.TG_API_HASH || '';
  if (!apiId || !apiHash) throw Object.assign(new Error(), { code: 'MISSING_TELEGRAM_CONFIG' });
  const config = loadAnalysisConfig(process.env);
  const initialSession = process.env.TG_SESSION || (fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : '');
  acquireLock();
  runtime = { pid: process.pid, version: 'superanalysis-1', startedAt: new Date().toISOString(), model: config.model, stage: 'connecting' };
  updateStatus({});
  client = new TelegramClient(new StringSession(initialSession), apiId, apiHash, { connectionRetries: 5, floodSleepThreshold: 30 });
  client.setLogLevel('error');
  await client.start({
    phoneNumber: async () => { updateStatus({ stage: 'awaiting_login' }); return input.text('Phone number (+7...): '); },
    phoneCode: async () => input.password('Telegram code: '),
    password: async () => input.password('2FA password: '),
    onError: error => console.error(`Telegram authorization: ${codeOf(error)}`),
  });
  if (!initialSession) {
    fs.writeFileSync(`${sessionFile}.tmp`, client.session.save(), { mode: 0o600 });
    fs.renameSync(`${sessionFile}.tmp`, sessionFile);
  }
  if (fs.existsSync(sessionFile)) fs.chmodSync(sessionFile, 0o600);
  const me = await client.getMe();
  const targetArg = process.argv[2] || process.env.TG_TARGET || '';
  const targetIds = new Set();
  for (const username of targetArg.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean)) {
    const target = await client.getEntity(username);
    if (target.className !== 'User') throw Object.assign(new Error(), { code: 'ONLY_PRIVATE_CHATS_SUPPORTED' });
    targetIds.add(String(target.id));
  }
  const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 60000 }) : null;
  const analyzer = openai ? createAnalyzer({ openai, config }) : null;
  const handler = createCommandHandler({ client, meId: String(me.id), analyzer, state: new DeliveryState(), targetIds,
    defaultLimit: Math.max(1, Math.min(100000, Number(process.env.MESSAGE_LIMIT) || 50)),
    maxMessages: Math.max(100, Math.min(1000000, Number(process.env.ANALYSIS_MAX_MESSAGES) || 100000)),
    status: updateStatus,
  });
  client.addEventHandler(async event => {
    try { await handler(event); } catch (error) { console.error(`Telegram delivery: ${codeOf(error)}`); }
  }, new NewMessage({ outgoing: true }));
  updateStatus({ stage: 'ready', authenticated: true, aiConfigured: Boolean(openai), targetMode: targetIds.size ? 'selected_private_chats' : 'all_owner_private_chats' });
  console.log(`Telegram Helper ready. Model: ${config.model}. Commands: суперанализ | анализ 50 | /question ... | /analysis_help`);
  console.log('Only your outgoing commands run analysis. Reports are sent to the same chat. No automatic replies to everyday phrases.');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
main().catch(async error => {
  console.error(`Startup failed: ${codeOf(error)}`);
  if (ownsLock) { updateStatus({ stage: 'failed', error: codeOf(error) }); fs.unlinkSync(lockFile); ownsLock = false; }
  try { if (client) await client.disconnect(); } catch {}
  process.exit(1);
});
