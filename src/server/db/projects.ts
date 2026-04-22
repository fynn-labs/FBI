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
}

export type UpdateProjectInput = Partial<CreateProjectInput>;

export class ProjectsRepo {
  constructor(private db: DB) {}

  create(input: CreateProjectInput): Project {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO projects
        (name, repo_url, default_branch, devcontainer_override_json,
         instructions, git_author_name, git_author_email,
         created_at, updated_at)
       VALUES (@name, @repo_url, @default_branch, @devcontainer_override_json,
               @instructions, @git_author_name, @git_author_email, @now, @now)`
    );
    const info = stmt.run({ ...input, now });
    return this.get(Number(info.lastInsertRowid))!;
  }

  get(id: number): Project | undefined {
    return this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as Project | undefined;
  }

  list(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as Project[];
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
          updated_at=@updated_at
         WHERE id=@id`
      )
      .run(merged);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}
