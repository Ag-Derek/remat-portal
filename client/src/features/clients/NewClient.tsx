import { useEffect, useState } from 'react';
import { type ClientType, clientTypes, createClient, isNotSignedIn } from '../../api';
import { Notice, type Problem, problemFrom } from '../../problem';
import { Dialog, DialogFoot, Field, useSending } from './ui';

/**
 * Adding a client, owned by whoever adds it. A name already recorded, however it is cased or
 * spaced, is refused by the server with the client's name as it is recorded, said under the box.
 */
export function NewClientDialog({
  onClose,
  onSignedOut,
}: {
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const [types, setTypes] = useState<ClientType[] | undefined>(undefined);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [loadProblem, setLoadProblem] = useState<Problem | undefined>(undefined);
  const sending = useSending(onClose, onSignedOut);

  useEffect(() => {
    clientTypes()
      .then((found) => {
        const offered = found.filter((type) => type.retiredOn === null);
        setTypes(offered);
        setTypeId(offered[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setLoadProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  return (
    <Dialog
      title="New client"
      intro="One record per organisation. You will be its owner."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(async () => {
            const id = await createClient({ name, typeId });
            /* Straight to its page, where its contacts, products and notes are added. */
            window.location.hash = `#/clients/client/${id}`;
          });
        }}
      >
        <Field
          label="Name"
          hint="As the organisation is known, for example ADB."
          error={sending.errorFor('name')}
        >
          {({ id, describedBy }) => (
            <input
              id={id}
              value={name}
              maxLength={120}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
              aria-invalid={sending.errorFor('name') === undefined ? undefined : true}
              disabled={sending.busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field label="Type" error={sending.errorFor('typeId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={typeId}
              aria-describedby={describedBy}
              disabled={sending.busy || types === undefined}
              onChange={(event) => {
                setTypeId(event.target.value);
              }}
            >
              {(types ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        {loadProblem === undefined ? null : <Notice problem={loadProblem} />}
        {(() => {
          const other = sending.other(['name', 'typeId']);
          return other === undefined ? null : <Notice problem={other} />;
        })()}

        <DialogFoot
          busy={sending.busy}
          disabled={name.trim() === '' || typeId === ''}
          doing="Adding…"
          done="Add client"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}
