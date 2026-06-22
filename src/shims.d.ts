declare module "node:fs" {
	const fs: any;
	export = fs;
}

declare module "node:os" {
	export function homedir(): string;
}

declare module "node:path" {
	export function dirname(path: string): string;
	export function existsSync(path: string): boolean;
	export function join(...parts: string[]): string;
	export function parse(path: string): { root: string };
	export function resolve(...parts: string[]): string;
}
