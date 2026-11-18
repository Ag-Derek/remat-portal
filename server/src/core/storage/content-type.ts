/**
 * What a file is, read from its bytes. Leave FR 12, NFR SEC 07; Clients SRS CLI 69.
 *
 * The name and the type the uploader claimed are never consulted: a file called `proposal.pdf`
 * is whatever its bytes say. Each application decides which of these it accepts; this only says
 * which one a file is, or that it is none of them.
 *
 * Office documents are zips. One is told from another, and from a plain archive, by reading the
 * archive's own list of entries: `word/` for a Word document, `xl/` for a workbook, `ppt/` for a
 * deck, each beside the `[Content_Types].xml` every Office file has.
 */

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Every type this can tell from the bytes. */
export const SNIFFABLE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  DOCX,
  XLSX,
  PPTX,
] as const;

export type SniffedType = (typeof SNIFFABLE_TYPES)[number];

/** A type as somebody says it: "PDF", "Word document". For the sentences that name them. */
export function sniffedTypeInWords(type: SniffedType): string {
  switch (type) {
    case 'application/pdf':
      return 'PDF';
    case 'image/jpeg':
      return 'JPG';
    case 'image/png':
      return 'PNG';
    case DOCX:
      return 'DOCX';
    case XLSX:
      return 'XLSX';
    default:
      return 'PPTX';
  }
}

/** What the bytes actually are, or null where they are none of {@link SNIFFABLE_TYPES}. */
export function sniffContentType(content: Buffer): SniffedType | null {
  if (startsWith(content, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf';
  }

  if (startsWith(content, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (startsWith(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  if (startsWith(content, [0x50, 0x4b])) {
    return officeTypeOf(zipEntryNames(content));
  }

  return null;
}

function startsWith(content: Buffer, magic: readonly number[]): boolean {
  return content.byteLength >= magic.length && magic.every((byte, at) => content[at] === byte);
}

/** Which Office document a zip is, from its entries, or null for any other zip. */
function officeTypeOf(names: readonly string[]): SniffedType | null {
  if (!names.includes('[Content_Types].xml')) {
    return null;
  }
  if (names.some((name) => name.startsWith('word/'))) {
    return DOCX;
  }
  if (names.some((name) => name.startsWith('xl/'))) {
    return XLSX;
  }
  if (names.some((name) => name.startsWith('ppt/'))) {
    return PPTX;
  }

  return null;
}

/**
 * The names in a zip's central directory.
 *
 * Read from the end of the file rather than by walking local headers, which is the only part of a
 * zip that is authoritative about what the archive contains.
 */
function zipEntryNames(content: Buffer): string[] {
  const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
  const CENTRAL_FILE_HEADER = 0x02014b50;

  if (content.byteLength < 22) {
    return [];
  }

  /* The record is last, after a comment of up to 64 KB. */
  const earliest = Math.max(0, content.byteLength - (0xffff + 22));
  let end = -1;

  for (let at = content.byteLength - 22; at >= earliest; at -= 1) {
    if (content.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }

  if (end === -1) {
    return [];
  }

  const entries = content.readUInt16LE(end + 10);
  let at = content.readUInt32LE(end + 16);
  const names: string[] = [];

  for (let read = 0; read < entries; read += 1) {
    if (at + 46 > content.byteLength || content.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      break;
    }

    const nameLength = content.readUInt16LE(at + 28);
    const extraLength = content.readUInt16LE(at + 30);
    const commentLength = content.readUInt16LE(at + 32);

    names.push(content.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}
