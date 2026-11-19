import { describe, expect, it } from 'vitest';
import {
  DOCX,
  PPTX,
  sniffContentType,
  sniffedTypeInWords,
  XLSX,
} from '../../src/core/storage/content-type.js';
import {
  A_DOCX,
  A_JPEG,
  A_PDF,
  A_PLAIN_ZIP,
  A_PNG,
  A_PPTX,
  A_PROGRAM,
  AN_XLSX,
  zip,
} from '../support/sample-files.js';

/**
 * What a file is, read from its bytes. Clients SRS CLI 69, leave NFR SEC 07, #281.
 *
 * Nothing here is told a name or a claimed type: there is no way to, which is the point.
 */

describe('what the bytes say a file is', () => {
  it('reads a PDF, a JPG and a PNG from how they start', () => {
    expect(sniffContentType(A_PDF)).toBe('application/pdf');
    expect(sniffContentType(A_JPEG)).toBe('image/jpeg');
    expect(sniffContentType(A_PNG)).toBe('image/png');
  });

  /* Three zips that start alike: what is inside tells them apart. */
  it('tells a Word document, a workbook and a deck apart by what the zip holds', () => {
    expect(sniffContentType(A_DOCX)).toBe(DOCX);
    expect(sniffContentType(AN_XLSX)).toBe(XLSX);
    expect(sniffContentType(A_PPTX)).toBe(PPTX);
  });

  it('calls a zip that is no Office document nothing', () => {
    expect(sniffContentType(A_PLAIN_ZIP)).toBeNull();
    /* The folders of one, without the list of types every Office file carries. */
    expect(sniffContentType(zip({ 'word/document.xml': '<document/>' }))).toBeNull();
    /* The list, with nothing it recognises beside it. */
    expect(sniffContentType(zip({ '[Content_Types].xml': '<Types/>', 'x/y.xml': '' }))).toBeNull();
  });

  it('calls a program, plain text and nothing at all nothing', () => {
    expect(sniffContentType(A_PROGRAM)).toBeNull();
    expect(sniffContentType(Buffer.from('%PD not quite a PDF'))).toBeNull();
    expect(sniffContentType(Buffer.from('Proposal for ADB'))).toBeNull();
    expect(sniffContentType(Buffer.alloc(0))).toBeNull();
  });

  it('calls a zip cut short, with no directory to read, nothing', () => {
    expect(sniffContentType(A_DOCX.subarray(0, A_DOCX.length - 30))).toBeNull();
    expect(sniffContentType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });

  it('reads the start and the directory, so a PDF stays a PDF whatever follows it', () => {
    expect(sniffContentType(Buffer.concat([A_PDF, A_DOCX]))).toBe('application/pdf');
  });

  it('names each type as somebody would', () => {
    expect(
      ['application/pdf', DOCX, XLSX, PPTX, 'image/png', 'image/jpeg'].map((type) =>
        sniffedTypeInWords(type as Parameters<typeof sniffedTypeInWords>[0]),
      ),
    ).toEqual(['PDF', 'DOCX', 'XLSX', 'PPTX', 'PNG', 'JPG']);
  });
});
