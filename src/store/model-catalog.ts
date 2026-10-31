import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AnyModel, ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { cachedCatalogSchema } from "../core/catalog-cache.ts";

/** The filesystem implementation of Pi's ModelsStore, not a second cache protocol. */
export function createFileModelsStore(directory: string): ModelsStore {
	const filename = (id: string) => path.join(directory, `${encodeURIComponent(id)}.json`);
	return {
		async read(id, options) {
			options?.signal?.throwIfAborted();
			let raw: unknown;
			const maximumBytes = 16 * 1024 * 1024;
			try {
				if (fs.statSync(filename(id)).size > maximumBytes) return undefined;
				raw = JSON.parse(fs.readFileSync(filename(id), "utf8"));
			}
			catch (error) { if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
			const parsed = cachedCatalogSchema.safeParse(raw);
			if (!parsed.success || parsed.data.models.some((model) => model.provider !== id)) return undefined;
			return parsed.data as ModelsStoreEntry & { models: AnyModel[] };
		},
		async write(id, entry, options) {
			options?.signal?.throwIfAborted();
			if (!cachedCatalogSchema.safeParse(entry).success || entry.models.some((model) => model.provider !== id)) throw new Error("Invalid persisted model catalog");
			fs.mkdirSync(directory, { recursive: true });
			const temporary = path.join(directory, `.${randomUUID()}.tmp`);
			try {
				fs.writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
				options?.signal?.throwIfAborted();
				fs.renameSync(temporary, filename(id));
			} finally { fs.rmSync(temporary, { force: true }); }
		},
		async delete(id, options) { options?.signal?.throwIfAborted(); fs.rmSync(filename(id), { force: true }); },
	};
}
