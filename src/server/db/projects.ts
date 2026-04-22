import type { DB } from './index.js';
import type { Project } from '../../shared/types.js';

export interface CreateProjectInput {
  name: string;
  repo_url: string;
  default_branch: string;
  devcontainer_override_json: string | null;
  instructions: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  marketplaces?: string[];
  plugins?: string[];
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

interface ProjectRow {
  id: number;
  name: string;
  repo_url: string;
  default_branch: string;
  devcontainer_override_json: string | null;
  instructions: string | null;
  git_author_name: string | null;
  git_author_email: string | null;
  marketplaces_json: string;
  plugins_json: string;
  created_at: number;
  updated_at: number;
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repo_url: row.repo_url,
    default_branch: row.default_branch,
    devcontainer_override_json: row.devcontainer_override_json,
    instructions: row.instructions,
    git_author_name: row.git_author_name,
    git_author_email: row.git_author_email,
    marketplaces: parseList(row.marketplaces_json),
    plugins: parseList(row.plugins_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  const v = JSON.parse(json) as unknown;
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

export class ProjectsRepo {
  constructor(private db: DB) {}

  create(input: CreateProjectInput): Project {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO projects
        (name, repo_url, default_branch, devcontainer_override_json,
         instructions, git_author_name, git_author_email,
         marketplaces_json, plugins_json,
         created_at, updated_at)
       VALUES (@name, @repo_url, @default_branch, @devcontainer_override_json,
               @instructions, @git_author_name, @git_author_email,
               @marketplaces_json, @plugins_json, @now, @now)`
    );
    const info = stmt.run({
      name: input.name,
      repo_url: input.repo_url,
      default_branch: input.default_branch,
      devcontainer_override_json: input.devcontainer_override_json,
      instructions: input.instructions,
      git_author_name: input.git_author_name,
      git_author_email: input.git_author_email,
      marketplaces_json: JSON.stringify(input.marketplaces ?? []),
      plugins_json: JSON.stringify(input.plugins ?? []),
      now,
    });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): Project[] {
    return (
      this.db
        .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
        .all() as ProjectRow[]
    ).map(fromRow);
  }

  update(id: number, patch: UpdateProjectInput): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Project ${id} not found`);
    const merged = { ...existing, ...patch, updated_at: Date.now() };
    this.db
      .prepare(
        `UPDATE projects SET
          name=@name, repo_url=@repo_url, default_branch=@default_branch,
          devcontainer_override_json=@devcontainer_override_json,
          instructions=@instructions,
          git_author_name=@git_author_name, git_author_email=@git_author_email,
          marketplaces_json=@marketplaces_json,
          plugins_json=@plugins_json,
          updated_at=@updated_at
         WHERE id=@id`
      )
      .run({
        id,
        name: merged.name,
        repo_url: merged.repo_url,
        default_branch: merged.default_branch,
        devcontainer_override_json: merged.devcontainer_override_json,
        instructions: merged.instructions,
        git_author_name: merged.git_author_name,
        git_author_email: merged.git_author_email,
        marketplaces_json: JSON.stringify(merged.marketplaces ?? []),
        plugins_json: JSON.stringify(merged.plugins ?? []),
        updated_at: merged.updated_at,
      });
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
