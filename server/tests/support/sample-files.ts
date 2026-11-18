import { deflateRawSync } from 'node:zlib';

/**
 * Files as their bytes, for tests of what a file is (CLI 69, NFR SEC 07): the smallest of each
 * that still starts the way a real one does, and Office documents as zips with a real central
 * directory, which is what tells one from another.
 */

export const A_PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n');

export const A_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

export const A_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

/** A minimal zip of `entries`, deflated, with its central directory. */
export function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(body);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const entry = Buffer.concat([local, nameBytes, deflated]);
    locals.push(entry);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(deflated.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);

    central.push(Buffer.concat([header, nameBytes]));
    offset += entry.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

export const A_DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  '_rels/.rels': '<Relationships/>',
  'word/document.xml': '<document/>',
});

export const AN_XLSX = zip({
  '[Content_Types].xml': '<Types/>',
  'xl/workbook.xml': '<workbook/>',
});

export const A_PPTX = zip({
  '[Content_Types].xml': '<Types/>',
  'ppt/presentation.xml': '<presentation/>',
});

/** A zip that is no Office document. */
export const A_PLAIN_ZIP = zip({ 'notes.txt': 'not a document' });

/** A Windows program, which starts MZ whatever it is called. */
export const A_PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);

/** The EICAR test string, which every scanner flags. Split so this file is not itself flagged. */
export const EICAR = Buffer.from(
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
  'latin1',
);

/** A PDF carrying it, so the type is accepted and it is the scanner that refuses it. */
export const AN_INFECTED_PDF = Buffer.concat([A_PDF, EICAR]);
