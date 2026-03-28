import * as fs from "fs/promises";
import * as path from "path";

interface AllowedUserChatData {
  chatId?: number;
  updatedAt?: string;
}

const DATA_DIR = path.join(__dirname, "..", "data");
const FILE_PATH = path.join(DATA_DIR, "allowed-user-chat.json");

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadStore(): Promise<AllowedUserChatData> {
  await ensureDir();

  try {
    const raw = await fs.readFile(FILE_PATH, "utf-8");
    return JSON.parse(raw) as AllowedUserChatData;
  } catch (error) {
    return {};
  }
}

export async function saveAllowedUserChatId(chatId: number): Promise<void> {
  const current = await loadStore();

  if (current.chatId === chatId) {
    return;
  }

  await fs.writeFile(
    FILE_PATH,
    JSON.stringify({ chatId, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
}

export async function getAllowedUserChatId(): Promise<number | undefined> {
  const data = await loadStore();
  return data.chatId;
}
