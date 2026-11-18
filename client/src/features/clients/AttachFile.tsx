import { useState } from 'react';
import { attachToActivity, attachToDeal, type ClientPage, DOCUMENT_ACCEPT } from '../../api';
import { Notice } from '../../problem';
import { OUTCOME } from './Deals';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * Attaching a file to a deal or an activity. #281, Clients SRS CLI 67.
 *
 * To a deal, open or ended, anybody with a role; to an activity, whoever logged it, at any time.
 * What the file is, and whether it may be kept, is the server's to say from its bytes (CLI 69):
 * the picker's list of types is a hint to the browser and nothing more.
 */

/** What the file goes on: one of the client's deals, chosen here, or one activity. */
export type AttachTarget =
  | { kind: 'DEAL'; client: ClientPage; dealId?: string }
  | { kind: 'ACTIVITY'; activityId: string; what: string };

/** "2.4 MB", "340 KB". */
export function sizeInWords(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
  }

  return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

export function AttachFileDialog({
  target,
  onSaved,
  onClose,
  onSignedOut,
}: {
  target: AttachTarget;
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const deals = target.kind === 'DEAL' ? target.client.opportunities : [];
  const [dealId, setDealId] = useState(
    target.kind === 'DEAL' ? (target.dealId ?? deals[0]?.id ?? '') : '',
  );
  const [file, setFile] = useState<File | null>(null);
  const sending = useSending(onSaved, onSignedOut);
  const other = sending.other(['file', 'filename', 'opportunityId']);

  return (
    <Dialog
      title="Attach a file"
      intro={
        target.kind === 'DEAL'
          ? 'PDF, Word, Excel, PowerPoint, PNG or JPG, up to 50 MB.'
          : `To ${target.what}. PDF, Word, Excel, PowerPoint, PNG or JPG, up to 50 MB.`
      }
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (file === null) return;

          sending.send(() =>
            target.kind === 'DEAL'
              ? attachToDeal(dealId, file)
              : attachToActivity(target.activityId, file),
          );
        }}
      >
        {target.kind === 'DEAL' ? (
          <Field label="To the deal">
            {({ id }) => (
              <select
                id={id}
                value={dealId}
                required
                disabled={sending.busy}
                onChange={(event) => {
                  setDealId(event.target.value);
                }}
              >
                {deals.map((deal) => (
                  <option key={deal.id} value={deal.id}>
                    {deal.product.name}
                    {deal.outcome === 'OPEN' ? '' : ` (${OUTCOME[deal.outcome].toLowerCase()})`}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}

        <Field label="File" error={sending.errorFor('file') ?? sending.errorFor('filename')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              type="file"
              accept={DOCUMENT_ACCEPT}
              required
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
              }}
            />
          )}
        </Field>

        {other === undefined ? null : <Notice problem={other} />}

        <DialogFoot
          busy={sending.busy}
          disabled={file === null || (target.kind === 'DEAL' && dealId === '')}
          doing="Uploading…"
          done="Attach it"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
