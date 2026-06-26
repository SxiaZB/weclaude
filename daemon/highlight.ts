// 服务端轻量代码高亮: 简易状态机 tokenizer, 不引外部依赖, 离线可用。
// 仅覆盖最常见的语言, 未识别时回退 escHtml。CSS 类与 detail.ts 的 SHARED_CSS 共享:
//   .hc 注释  .hs 字符串  .hk 关键字  .hl 字面量  .hn 数字  .hv 变量

const ESC_RE = /[&<>"']/g;
const ESC_MAP: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
const escHtml = (s: string): string => s.replace(ESC_RE, (c) => ESC_MAP[c]!);

const KEYWORDS = {
  bash: ["if","then","elif","else","fi","for","in","do","done","while","until","case","esac","function","return","break","continue","exit","local","export","set","trap","source","alias","unset","read","test","let","declare","typeset","select","time"],
  ts: ["abstract","as","async","await","break","case","catch","class","const","continue","debugger","declare","default","delete","do","else","enum","export","extends","finally","for","from","function","get","if","implements","import","in","instanceof","interface","is","keyof","let","module","namespace","new","of","package","private","protected","public","readonly","require","return","satisfies","set","static","super","switch","throw","try","type","typeof","var","void","while","with","yield"],
  py: ["and","as","assert","async","await","break","class","continue","def","del","elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal","not","or","pass","raise","return","try","while","with","yield","match","case"],
  go: ["break","case","chan","const","continue","default","defer","else","fallthrough","for","func","go","goto","if","import","interface","map","package","range","return","select","struct","switch","type","var"],
  rust: ["as","async","await","break","const","continue","crate","dyn","else","enum","extern","fn","for","if","impl","in","let","loop","match","mod","move","mut","pub","ref","return","self","static","struct","super","trait","try","type","unsafe","use","where","while"],
} as const;

const LITERALS = ["true","false","null","undefined","None","True","False","nil","NaN","Infinity"];

interface Profile {
  keywords: readonly string[];
  lineComment?: readonly string[];
  blockComment?: readonly (readonly [string, string])[];
  strings?: readonly string[];
  /** bash $foo / ${foo} */
  variables?: boolean;
  /** # 作为注释只在词边界起作用 (bash 风格) */
  commentNeedsBoundary?: boolean;
}

const PROFILES: Record<string, Profile> = {
  bash: { keywords: KEYWORDS.bash, lineComment: ["#"], strings: ["'", '"', "`"], variables: true, commentNeedsBoundary: true },
  ts:   { keywords: KEYWORDS.ts, lineComment: ["//"], blockComment: [["/*", "*/"]], strings: ["'", '"', "`"] },
  py:   { keywords: KEYWORDS.py, lineComment: ["#"], strings: ["'", '"'] },
  go:   { keywords: KEYWORDS.go, lineComment: ["//"], blockComment: [["/*", "*/"]], strings: ['"', "`"] },
  rust: { keywords: KEYWORDS.rust, lineComment: ["//"], blockComment: [["/*", "*/"]], strings: ['"'] },
};

const EXT_LANG: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  py: "py", pyw: "py", pyi: "py",
  go: "go",
  rs: "rust",
};

export const langFromPath = (path: string): string | undefined => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(path);
  if (!m) return undefined;
  return EXT_LANG[m[1]!.toLowerCase()];
};

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentCont = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const wordBoundary = (c: string | undefined): boolean =>
  c === undefined || /[\s;|&<>(){}\[\]`'"=]/.test(c);

const NUM_RE = /^0[xX][0-9a-fA-F]+|^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;

export const highlightCode = (src: string, lang?: string): string => {
  const p = lang ? PROFILES[lang] : undefined;
  if (!p) return escHtml(src);

  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i]!;

    // line comment
    if (p.lineComment) {
      const lc = p.lineComment.find((s) => src.startsWith(s, i));
      if (lc) {
        const ok = !p.commentNeedsBoundary || wordBoundary(i === 0 ? undefined : src[i - 1]);
        if (ok) {
          const eol = src.indexOf("\n", i);
          const end = eol === -1 ? n : eol;
          out += `<span class="hc">${escHtml(src.slice(i, end))}</span>`;
          i = end;
          continue;
        }
      }
    }

    // block comment
    if (p.blockComment) {
      const bc = p.blockComment.find(([open]) => src.startsWith(open, i));
      if (bc) {
        const [open, close] = bc;
        const ce = src.indexOf(close, i + open.length);
        const end = ce === -1 ? n : ce + close.length;
        out += `<span class="hc">${escHtml(src.slice(i, end))}</span>`;
        i = end;
        continue;
      }
    }

    // string
    if (p.strings) {
      const q = p.strings.find((s) => src.startsWith(s, i));
      if (q) {
        let j = i + q.length;
        while (j < n) {
          if (src[j] === "\\" && j + 1 < n) { j += 2; continue; }
          if (src.startsWith(q, j)) { j += q.length; break; }
          // 单 / 双引号不跨行: 防止整段被吞 (常见场景: 一行有奇数个引号)
          if (src[j] === "\n" && q !== "`") break;
          j++;
        }
        out += `<span class="hs">${escHtml(src.slice(i, j))}</span>`;
        i = j;
        continue;
      }
    }

    // bash variable: $foo / ${foo} / $1 / $$ / $@ / $#
    if (p.variables && c === "$") {
      const next = src[i + 1] ?? "";
      let j = i + 1;
      if (next === "{") {
        const close = src.indexOf("}", j + 1);
        j = close === -1 ? n : close + 1;
      } else if (isIdentStart(next)) {
        while (j < n && isIdentCont(src[j]!)) j++;
      } else if (/[0-9#@*?$!\-]/.test(next)) {
        j++;
      } else {
        out += escHtml(c);
        i++;
        continue;
      }
      out += `<span class="hv">${escHtml(src.slice(i, j))}</span>`;
      i = j;
      continue;
    }

    // identifier → keyword / literal / plain
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentCont(src[j]!)) j++;
      const word = src.slice(i, j);
      if (p.keywords.includes(word)) out += `<span class="hk">${escHtml(word)}</span>`;
      else if (LITERALS.includes(word)) out += `<span class="hl">${escHtml(word)}</span>`;
      else out += escHtml(word);
      i = j;
      continue;
    }

    // number
    if (isDigit(c)) {
      const m = NUM_RE.exec(src.slice(i));
      const len = m ? m[0].length : 1;
      out += `<span class="hn">${escHtml(src.slice(i, i + len))}</span>`;
      i += len;
      continue;
    }

    out += escHtml(c);
    i++;
  }
  return out;
};
