// Small syntax highlighter for the documentation site (src/services/docs.ts).
// Runs once per code block at startup and emits <span class="tk-*"> markup, so
// the browser ships no highlighting library.

type Classifier = (match: string, code: string, end: number) => string | null;
type Rule = [RegExp, string | null | Classifier];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function words(list: string): Set<string> {
  return new Set(list.split(" "));
}

const TS_KEYWORDS = words(
  "abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace never new number object of package private protected public readonly return satisfies set static string switch symbol throw try type typeof unique unknown var void while with yield"
);
const TS_CONSTANTS = words("true false null undefined NaN Infinity this super globalThis");

const BASH_KEYWORDS = words("if then else elif fi for while until do done case esac in function return exit export local source set unset");

const SQL_KEYWORDS = words(
  "ADD ALL ALTER AND AS ASC AUTO_INCREMENT AUTOINCREMENT BEGIN BETWEEN BY CASCADE CASE CHECK COLUMN COMMIT CONSTRAINT CREATE CROSS DATABASE DEFAULT DELETE DESC DISTINCT DROP DUPLICATE ELSE END EXISTS FOREIGN FROM FULL GROUP HAVING IF IGNORE IN INDEX INNER INSERT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES REPLACE RIGHT ROLLBACK SELECT SET SHOW TABLE THEN TRANSACTION TRUNCATE UNION UNIQUE UPDATE USE VALUES VIEW WHEN WHERE"
);
const SQL_TYPES = words(
  "BIGINT BINARY BLOB BOOL BOOLEAN CHAR DATE DATETIME DECIMAL DOUBLE ENUM FLOAT INT INTEGER JSON LONGTEXT MEDIUMINT MEDIUMTEXT NUMERIC REAL SMALLINT TEXT TIME TIMESTAMP TINYINT UNSIGNED VARBINARY VARCHAR"
);

const DOUBLE_STRING = /"(?:\\[\s\S]|[^"\\\n])*"/y;
const SINGLE_STRING = /'(?:\\[\s\S]|[^'\\\n])*'/y;
const NUMBER = /\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b/y;
const HASH_COMMENT = /(?<=^|\s)#[^\n]*/my;

const followedByCall = (code: string, end: number): boolean => {
  let i = end;
  while (code[i] === " ") i++;
  return code[i] === "(";
};

const typescript: Rule[] = [
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, "c"],
  // Regex literal: only where an expression can start, so division is left alone.
  [/(?<=(?:^|[(,=:[!&|?{};]|\breturn)\s*)\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n])+\/[dgimsuvy]*/my, "s"],
  [DOUBLE_STRING, "s"],
  [SINGLE_STRING, "s"],
  [/`(?:\\[\s\S]|[^`\\])*`/y, "s"],
  [NUMBER, "n"],
  [/[A-Za-z_$][\w$]*/y, (match, code, end) => {
    if (TS_KEYWORDS.has(match)) return "k";
    if (TS_CONSTANTS.has(match)) return "b";
    if (followedByCall(code, end)) return "f";
    if (/^[A-Z]/.test(match)) return "t";
    return null;
  }],
  // "/" is matched on its own so it cannot swallow the start of a regex literal.
  [/[{}()[\];,.<>+\-*%=!&|^~?:]+|\//y, "o"],
];

const json: Rule[] = [
  [/"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)/y, "p"],
  [DOUBLE_STRING, "s"],
  [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, "c"],
  [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, "n"],
  [/\b(?:true|false|null)\b/y, "b"],
  [/[{}[\],:]+/y, "o"],
];

const bash: Rule[] = [
  [HASH_COMMENT, "c"],
  [DOUBLE_STRING, "s"],
  [/'[^'\n]*'/y, "s"],
  [/\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[\d@*#?$!-])/y, "v"],
  [/(?<=\s)--?[A-Za-z][\w-]*/y, "p"],
  [/(?<=^[ \t]*|[|;&][ \t]*|\$\([ \t]*)[A-Za-z_./~][\w./~:@-]*/my, (match) => (BASH_KEYWORDS.has(match) ? "k" : "f")],
  [/[A-Za-z_][\w-]*/y, (match) => (BASH_KEYWORDS.has(match) ? "k" : null)],
  [/[|&;<>]+/y, "o"],
];

const sql: Rule[] = [
  [/--[^\n]*|\/\*[\s\S]*?\*\//y, "c"],
  [/'(?:''|\\[\s\S]|[^'\\])*'/y, "s"],
  [DOUBLE_STRING, "s"],
  [/`[^`\n]*`/y, "v"],
  [NUMBER, "n"],
  [/[A-Za-z_]\w*/y, (match, code, end) => {
    const upper = match.toUpperCase();
    if (SQL_KEYWORDS.has(upper)) return "k";
    if (SQL_TYPES.has(upper)) return "t";
    if (followedByCall(code, end)) return "f";
    return null;
  }],
  [/[(),;=<>*+\-/.]+/y, "o"],
];

const env: Rule[] = [
  [HASH_COMMENT, "c"],
  [/^[ \t]*\[[^\]\n]*\]/my, "k"],
  [/^[ \t]*(?:export[ \t]+)?[A-Za-z_][\w.-]*(?=[ \t]*=)/my, "p"],
  [DOUBLE_STRING, "s"],
  [SINGLE_STRING, "s"],
  [/(?<==[ \t]*)(?:true|false|on|off|yes|no)(?=[ \t]*(?:\n|$))/y, "b"],
  [/(?<==[ \t]*)-?\d+(?:\.\d+)?(?=[ \t]*(?:\n|$))/y, "n"],
  [/=/y, "o"],
];

const yaml: Rule[] = [
  [HASH_COMMENT, "c"],
  [/^[ \t]*(?:-[ \t]+)?[A-Za-z_][\w.-]*(?=:(?:[ \t]|\n|$))/my, "p"],
  [DOUBLE_STRING, "s"],
  [SINGLE_STRING, "s"],
  [/\b(?:true|false|null|yes|no)\b/y, "b"],
  [NUMBER, "n"],
  [/[:\-[\]{},|>]+/y, "o"],
];

const html: Rule[] = [
  [/<!--[\s\S]*?-->/y, "c"],
  [/<\/?[A-Za-z][\w:-]*|\/?>/y, "k"],
  [/[A-Za-z_:@][\w:.-]*(?==)/y, "p"],
  [DOUBLE_STRING, "s"],
  [SINGLE_STRING, "s"],
];

const css: Rule[] = [
  [/\/\*[\s\S]*?\*\//y, "c"],
  [DOUBLE_STRING, "s"],
  [SINGLE_STRING, "s"],
  [/@[\w-]+/y, "k"],
  [/--[\w-]+/y, "v"],
  [/#[\da-fA-F]{3,8}\b/y, "n"],
  [/-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?/y, "n"],
  [/[A-Za-z-]+(?=\s*:)/y, "p"],
  [/[{}();:,>+~]+/y, "o"],
];

const GRAMMARS: Record<string, Rule[]> = { typescript, json, bash, sql, env, yaml, html, css };

// Fence language -> [grammar, label shown on the code block]
const LANGUAGES: Record<string, [string, string]> = {
  ts: ["typescript", "TypeScript"],
  typescript: ["typescript", "TypeScript"],
  tsx: ["typescript", "TSX"],
  js: ["typescript", "JavaScript"],
  javascript: ["typescript", "JavaScript"],
  jsx: ["typescript", "JSX"],
  mjs: ["typescript", "JavaScript"],
  json: ["json", "JSON"],
  jsonc: ["json", "JSON"],
  bash: ["bash", "Shell"],
  sh: ["bash", "Shell"],
  shell: ["bash", "Shell"],
  zsh: ["bash", "Shell"],
  powershell: ["bash", "PowerShell"],
  sql: ["sql", "SQL"],
  mysql: ["sql", "MySQL"],
  sqlite: ["sql", "SQLite"],
  env: ["env", "Env"],
  dotenv: ["env", "Env"],
  ini: ["env", "INI"],
  cfg: ["env", "Config"],
  conf: ["env", "Config"],
  toml: ["env", "TOML"],
  yaml: ["yaml", "YAML"],
  yml: ["yaml", "YAML"],
  html: ["html", "HTML"],
  xml: ["html", "XML"],
  css: ["css", "CSS"],
  dockerfile: ["bash", "Dockerfile"],
  diff: ["diff", "Diff"],
  md: ["text", "Markdown"],
  markdown: ["text", "Markdown"],
  text: ["text", "Text"],
  txt: ["text", "Text"],
};

function tokenize(code: string, rules: Rule[]): string {
  let out = "";
  let plain = "";
  let i = 0;

  while (i < code.length) {
    let matched = false;
    for (const [pattern, classifier] of rules) {
      pattern.lastIndex = i;
      const match = pattern.exec(code);
      if (!match || match[0].length === 0) continue;

      const text = match[0];
      const end = i + text.length;
      const cls = typeof classifier === "function" ? classifier(text, code, end) : classifier;
      if (cls) {
        out += escapeHtml(plain) + `<span class="tk-${cls}">${escapeHtml(text)}</span>`;
        plain = "";
      } else {
        plain += text;
      }
      i = end;
      matched = true;
      break;
    }
    if (!matched) plain += code[i++];
  }

  return out + escapeHtml(plain);
}

function highlightDiff(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (line.startsWith("+")) return `<span class="tk-ins">${escapeHtml(line)}</span>`;
      if (line.startsWith("-")) return `<span class="tk-del">${escapeHtml(line)}</span>`;
      if (line.startsWith("@@")) return `<span class="tk-c">${escapeHtml(line)}</span>`;
      return escapeHtml(line);
    })
    .join("\n");
}

export function languageLabel(lang: string): string {
  return LANGUAGES[lang]?.[1] ?? (lang ? lang.toUpperCase() : "Text");
}

// Returns HTML-safe markup for `code` (raw, unescaped source text).
export function highlight(code: string, lang: string): string {
  const grammar = LANGUAGES[lang]?.[0];
  if (grammar === "diff") return highlightDiff(code);
  const rules = grammar ? GRAMMARS[grammar] : undefined;
  return rules ? tokenize(code, rules) : escapeHtml(code);
}
