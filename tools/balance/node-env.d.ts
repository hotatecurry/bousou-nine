/**
 * `tools/` は Node（vite-node）で動かすので `node:fs` と `process` を使うが、
 * このプロジェクトは `@types/node` を入れていない（`tsconfig.json` の types は
 * `vite/client` だけ＝ブラウザで動く `src/` に合わせてある）。
 *
 * **依存を1つ増やすより、ここで使う分だけを宣言する**ほうが軽い
 * （E-25で「読み込みは three 同梱の GLTFLoader＝依存の追加なし」を選んだのと同じ判断）。
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare const process: {
  argv: string[];
  exit(code?: number): never;
};
