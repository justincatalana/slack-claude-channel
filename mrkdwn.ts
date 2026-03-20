/**
 * Convert Markdown to Slack mrkdwn format.
 * Best-effort — handles common patterns, not a full parser.
 */
export function toMrkdwn(md: string): string {
  // Split into code blocks and non-code segments
  const parts: string[] = [];
  let cursor = 0;

  // Match fenced code blocks (``` ... ```)
  const codeBlockRe = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRe.exec(md)) !== null) {
    if (match.index > cursor) {
      parts.push(convertSegment(md.slice(cursor, match.index)));
    }
    parts.push(match[0]); // code blocks pass through
    cursor = match.index + match[0].length;
  }

  if (cursor < md.length) {
    parts.push(convertSegment(md.slice(cursor)));
  }

  return parts.join("");
}

function convertSegment(text: string): string {
  // Protect inline code from other transforms
  const inlineCode: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_match, code) => {
    inlineCode.push(code);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // Bold: **text** → *text*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Italic: standalone *text* (not bold) → _text_
  // After bold conversion, remaining single *text* are italic
  text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "_$1_");

  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Headers: ### Header → *Header* (bold)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Restore inline code
  text = text.replace(/\x00IC(\d+)\x00/g, (_match, idx) => {
    return "`" + inlineCode[parseInt(idx)] + "`";
  });

  return text;
}
