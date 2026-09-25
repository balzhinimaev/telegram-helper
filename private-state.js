import fs from 'node:fs';
import path from 'node:path';

export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

// Only message IDs, never message contents or credentials.
export class DeliveryState {
  constructor(file = '.analysis-cache/delivery.json') {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { handled: {}, sent: {} };
    if (!this.data.handled || !this.data.sent) throw new Error('Invalid delivery state');
  }
  has(chat, id) { return (this.data.handled[chat] || []).includes(Number(id)); }
  excluded(chat) { return new Set(this.data.sent[chat] || []); }
  remember(kind, chat, id) {
    const list = this.data[kind][chat] ||= [];
    if (!list.includes(Number(id))) list.push(Number(id));
    // Generated outputs have a permanent text marker, too.
    this.data[kind][chat] = list.slice(-10000);
    writePrivateJson(this.file, this.data);
  }
}
