import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface KnowledgeHit {
  title: string;
  source: string;
  excerpt: string;
}

interface KnowledgeDocument {
  fileName: string;
  title: string;
  source: string;
}

const UPSTREAM_COMMIT = "12dc27d3b6d0a261f0fbd14a046d492cba8c6e27";
const KNOWLEDGE_DOCUMENTS: readonly KnowledgeDocument[] = [{
  fileName: "morandot-dont-starve-skill.md",
  title: "DST survival decision guide",
  source: `morandot/dont-starve-skill@${UPSTREAM_COMMIT}:dont-starve-skill/SKILL.md (MIT; Copyright (c) 2026 moran)`,
}];

export class GatewayStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      const absolutePath = resolve(databasePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      this.db = new DatabaseSync(absolutePath);
    } else {
      this.db = new DatabaseSync(":memory:");
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS action_audit (
        id INTEGER PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        companion_id TEXT NOT NULL,
        event TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL UNIQUE
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title,
        body,
        source UNINDEXED
      );
    `);
    this.seedKnowledge();
  }

  close(): void {
    this.db.close();
  }

  setMemory(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO memories (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, Date.now());
  }

  getMemory(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM memories WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value;
  }

  setCompanionMemory(companionId: string, key: string, value: string): void {
    this.setMemory(this.companionMemoryKey(companionId, key), value);
  }

  getCompanionMemory(companionId: string, key: string): string | undefined {
    return this.getMemory(this.companionMemoryKey(companionId, key));
  }

  addAudit(companionId: string, event: string, metadata: Record<string, unknown> = {}): void {
    const safeMetadata = JSON.stringify(metadata, (_key, value) => typeof value === "string" ? value.slice(0, 160) : value);
    this.db.prepare("INSERT INTO action_audit (occurred_at, companion_id, event, metadata) VALUES (?, ?, ?, ?)")
      .run(Date.now(), companionId, event.slice(0, 64), safeMetadata);
  }

  recentAudit(limit = 20): Array<{ occurredAt: number; companionId: string; event: string; metadata: Record<string, unknown> }> {
    const rows = this.db.prepare(`
      SELECT occurred_at, companion_id, event, metadata
      FROM action_audit ORDER BY id DESC LIMIT ?
    `).all(Math.max(1, Math.min(limit, 100))) as Array<{ occurred_at: number; companion_id: string; event: string; metadata: string }>;
    return rows.map((row) => ({
      occurredAt: row.occurred_at,
      companionId: row.companion_id,
      event: row.event,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    }));
  }

  searchKnowledge(query: string, limit = 4): KnowledgeHit[] {
    const tokens = query.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff\s]/g, " ").trim().split(/\s+/).filter((token) => token.length > 1).slice(0, 8);
    if (tokens.length === 0) {
      return [];
    }
    const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
    const rows = this.db.prepare(`
      SELECT title, source, snippet(knowledge_fts, 1, '[', ']', '...', 22) AS excerpt
      FROM knowledge_fts WHERE knowledge_fts MATCH ? LIMIT ?
    `).all(ftsQuery, Math.max(1, Math.min(limit, 8))) as Array<{ title: string; source: string; excerpt: string }>;
    return rows;
  }

  private seedKnowledge(): void {
    const legacySourcePattern = "Locally curated DST starter guidance%";
    this.db.prepare("DELETE FROM knowledge_fts WHERE source LIKE ?").run(legacySourcePattern);
    this.db.prepare("DELETE FROM knowledge WHERE source LIKE ?").run(legacySourcePattern);

    for (const document of KNOWLEDGE_DOCUMENTS) {
      const body = readKnowledgeDocument(document.fileName);
      this.db.prepare(`
        INSERT INTO knowledge (title, body, source) VALUES (?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET title = excluded.title, body = excluded.body
      `).run(document.title, body, document.source);
      this.db.prepare("DELETE FROM knowledge_fts WHERE source = ?").run(document.source);
      this.db.prepare("INSERT INTO knowledge_fts (title, body, source) VALUES (?, ?, ?)")
        .run(document.title, body, document.source);
    }
  }

  private companionMemoryKey(companionId: string, key: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(companionId) || !/^[a-z0-9_.-]{1,64}$/.test(key)) {
      throw new Error("Invalid structured companion memory key.");
    }
    return `companion:${companionId}:${key}`;
  }
}

function readKnowledgeDocument(fileName: string): string {
  const locations = [
    resolve(process.cwd(), "knowledge", fileName),
    resolve(process.cwd(), "agent-gateway", "knowledge", fileName),
  ];
  const location = locations.find((candidate) => existsSync(candidate));
  if (!location) {
    throw new Error(`DST knowledge package is missing: ${fileName}`);
  }
  return readFileSync(location, "utf8").replace(/\r\n/g, "\n").trim();
}
