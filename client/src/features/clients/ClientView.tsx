import { useCallback, useEffect, useState } from 'react';
import {
  addContact,
  addProductInUse,
  ApiError,
  changeClient,
  changeContact,
  changeProductInUse,
  type ClientContact,
  type ClientPage,
  type ClientProductInUse,
  type ClientsNamed,
  type ClientsOfferedProduct,
  type ClientType,
  clientPage,
  clientTypes,
  clientsHolders,
  type ContactDetails,
  isNotSignedIn,
  offeredProducts,
  removeOrRestoreContact,
} from '../../api';
import { AddButton, EditButton } from '../../ActionButtons';
import { day } from '../../format';
import { Icon } from '../../Icon';
import { Notice, type Problem, problemFrom } from '../../problem';
import { ClientDeals, OpportunityFigures } from './Deals';
import { Dialog, DialogFoot, Field, Missing, useSending } from './ui';

/**
 * One client: who they are, what is in play with them and what it is worth, the products they
 * already use, and the people the department deals with there. #276, #277, Clients SRS CLI 01
 * to CLI 06, CLI 99.
 *
 * Laid out as the client page mockup: the client and its figures across the top, its open
 * opportunities beside a column of what it uses, who to talk to and the note. Its activity and
 * proposals join the left column once they are built (#280, #281).
 *
 * Everything optional that nobody has filled in is said by name, "No email", rather than left
 * blank (CLI 06). What the page offers to change is the server's answer in `may`; the server
 * refuses anything else whatever is drawn.
 */
export function ClientView({ id, onSignedOut }: { id: string; onSignedOut: () => void }) {
  const [client, setClient] = useState<ClientPage | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [notFound, setNotFound] = useState(false);
  const [open, setOpen] = useState<Open>(null);

  const load = useCallback(() => {
    clientPage(id)
      .then((found) => {
        setClient(found);
        setProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setNotFound(true);
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [id, onSignedOut]);

  useEffect(load, [load]);

  const close = () => {
    setOpen(null);
  };
  const saved = () => {
    setOpen(null);
    load();
  };

  if (notFound) {
    return (
      <section className="clients-client">
        <a className="clients-back" href="#/clients">
          <Icon name="back" />
          All clients
        </a>
        <div className="notice plain">
          <p>No client matches that. It may have been renamed: find it in the list.</p>
        </div>
      </section>
    );
  }

  const current = client?.contacts.filter((contact) => contact.removedAt === null) ?? [];
  const removed = client?.contacts.filter((contact) => contact.removedAt !== null) ?? [];

  return (
    <section className="clients-client">
      <a className="clients-back" href="#/clients">
        <Icon name="back" />
        All clients
      </a>

      {problem === undefined ? null : <Notice problem={problem} onRetry={load} />}

      {client === undefined ? null : (
        <>
          {/* -------------------------------------------------------------- who */}

          <header className="clients-client-head">
            <div>
              <span className="tag">{client.type.name}</span>
              <div className="clients-client-title">
                <h2>{client.name}</h2>
                {client.may.change ? (
                  <EditButton
                    label={`Edit ${client.name}'s name, type and note`}
                    onClick={() => {
                      setOpen({ what: 'details' });
                    }}
                  />
                ) : null}
              </div>
              <p className="clients-client-lede">
                Owned by {client.owner.name}.{' '}
                {current.length === 0
                  ? 'No contacts yet.'
                  : `Contacts: ${listed(current.map((contact) => contact.name))}.`}
                {client.may.reassign ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        setOpen({ what: 'owner' });
                      }}
                    >
                      Move to somebody else
                    </button>
                  </>
                ) : null}
              </p>
            </div>
          </header>

          {/* ------------------------------------------------------- the figures */}

          <OpportunityFigures deals={client.opportunities} />

          <div className="clients-client-body">
            {/* ------------------------------------------------- opportunities */}

            <div className="clients-client-main">
              <ClientDeals client={client} onChanged={load} onSignedOut={onSignedOut} />
            </div>

            <aside className="clients-client-side">
              {/* ---------------------------------------------- already using */}

              <section className="clients-panel" aria-labelledby="clients-using-heading">
                <header className="clients-side-head">
                  <h3 id="clients-using-heading">Already using</h3>
                  {client.may.contribute ? (
                    <AddButton
                      label="Add a product they use"
                      onClick={() => {
                        setOpen({ what: 'add-product' });
                      }}
                    />
                  ) : null}
                </header>

                {client.products.length === 0 ? (
                  <p className="muted">Nothing recorded yet.</p>
                ) : (
                  <ul className="clients-side-list">
                    {client.products.map((product) => (
                      <li
                        key={product.productId}
                        className={product.endedOn === null ? undefined : 'is-ended'}
                      >
                        <div>
                          <strong>{product.productName}</strong>
                          <small>
                            {product.lineName} · since {day(product.sinceOn)}
                            {product.endedOn === null ? null : `, stopped ${day(product.endedOn)}`}
                          </small>
                        </div>
                        {client.may.contribute ? (
                          <EditButton
                            label={`Change the dates for ${product.productName}`}
                            onClick={() => {
                              setOpen({ what: 'product-dates', product });
                            }}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* --------------------------------------------------- contacts */}

              <section className="clients-panel" aria-labelledby="clients-contacts-heading">
                <header className="clients-side-head">
                  <h3 id="clients-contacts-heading">Contacts</h3>
                  {client.may.contribute ? (
                    <AddButton
                      label="Add a contact"
                      onClick={() => {
                        setOpen({ what: 'contact' });
                      }}
                    />
                  ) : null}
                </header>

                {current.length === 0 ? (
                  <p className="muted">Nobody at {client.name} is recorded yet.</p>
                ) : (
                  <ul className="clients-side-list">
                    {current.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        may={client.may.contribute}
                        onEdit={() => {
                          setOpen({ what: 'contact', contact });
                        }}
                        onChanged={load}
                        onSignedOut={onSignedOut}
                      />
                    ))}
                  </ul>
                )}

                {removed.length === 0 ? null : (
                  <details className="clients-ended">
                    <summary>
                      {removed.length === 1
                        ? '1 former contact'
                        : `${String(removed.length)} former contacts`}
                    </summary>
                    <ul className="clients-side-list">
                      {removed.map((contact) => (
                        <ContactRow
                          key={contact.id}
                          contact={contact}
                          may={client.may.contribute}
                          onEdit={() => undefined}
                          onChanged={load}
                          onSignedOut={onSignedOut}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </section>

              {/* ------------------------------------------------------- note */}

              <section className="clients-panel" aria-labelledby="clients-note-heading">
                <header className="clients-side-head">
                  <h3 id="clients-note-heading">Note</h3>
                </header>
                <p className="clients-note">
                  {client.note === null ? <Missing what="note" /> : client.note}
                </p>
              </section>
            </aside>
          </div>

          {open?.what === 'details' ? (
            <DetailsDialog
              client={client}
              onSaved={saved}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}
          {open?.what === 'owner' ? (
            <OwnerDialog
              client={client}
              onSaved={saved}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}
          {open?.what === 'contact' ? (
            <ContactDialog
              clientId={client.id}
              contact={open.contact}
              onSaved={saved}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}
          {open?.what === 'add-product' ? (
            <AddProductDialog
              client={client}
              onSaved={saved}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}
          {open?.what === 'product-dates' ? (
            <ProductDatesDialog
              clientId={client.id}
              product={open.product}
              onSaved={saved}
              onClose={close}
              onSignedOut={onSignedOut}
            />
          ) : null}
        </>
      )}
    </section>
  );
}

/** "Ama", "Ama and Kofi", "Ama, Kofi and Esi". */
function listed(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

/** Which dialog is open, and on what. */
type Open =
  | { what: 'details' }
  | { what: 'owner' }
  | { what: 'contact'; contact?: ClientContact }
  | { what: 'add-product' }
  | { what: 'product-dates'; product: ClientProductInUse }
  | null;

interface DialogProps {
  onSaved: () => void;
  onClose: () => void;
  onSignedOut: () => void;
}

/**
 * One contact: the name, the job title under it, and how to reach them, each said by name where
 * nobody has filled it in (CLI 06).
 */
function ContactRow({
  contact,
  may,
  onEdit,
  onChanged,
  onSignedOut,
}: {
  contact: ClientContact;
  may: boolean;
  onEdit: () => void;
  onChanged: () => void;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const isRemoved = contact.removedAt !== null;

  const removeOrRestore = () => {
    setBusy(true);
    setProblem(undefined);

    removeOrRestoreContact(contact.id, isRemoved ? 'restore' : 'remove')
      .then(onChanged)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <li className={isRemoved ? 'is-ended' : undefined}>
      <div>
        <strong>{contact.name}</strong>
        <small>{contact.jobTitle ?? <Missing what="job title" />}</small>
      </div>
      {may ? (
        <span className="clients-setup-buttons">
          {isRemoved ? null : <EditButton label={`Edit ${contact.name}`} onClick={onEdit} />}
          <button type="button" className="linkish" disabled={busy} onClick={removeOrRestore}>
            {isRemoved ? 'Bring back' : 'Remove'}
          </button>
        </span>
      ) : null}
      <small className="clients-contact-ways">
        {contact.email === null ? (
          <Missing what="email" />
        ) : (
          <a href={`mailto:${contact.email}`}>{contact.email}</a>
        )}
        {contact.phone === null ? (
          <Missing what="phone" />
        ) : (
          <a href={`tel:${contact.phone.replace(/[^\d+]/g, '')}`}>{contact.phone}</a>
        )}
      </small>
      {problem === undefined ? null : <Notice problem={problem} />}
    </li>
  );
}

/** Name, type and note: the owner's or a BD manager's. */
function DetailsDialog({
  client,
  onSaved,
  onClose,
  onSignedOut,
}: DialogProps & { client: ClientPage }) {
  const [types, setTypes] = useState<ClientType[] | undefined>(undefined);
  const [name, setName] = useState(client.name);
  const [typeId, setTypeId] = useState(client.type.id);
  const [note, setNote] = useState(client.note ?? '');
  const sending = useSending(onSaved, onSignedOut);

  useEffect(() => {
    clientTypes()
      .then((found) => {
        /* Retired types are not offered, but the one it already has stays choosable. */
        setTypes(found.filter((type) => type.retiredOn === null || type.id === client.type.id));
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [client.type.id, onSignedOut]);

  return (
    <Dialog title={`Edit ${client.name}`} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => changeClient(client.id, { name, typeId, note }));
        }}
      >
        <Field label="Name" error={sending.errorFor('name')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              value={name}
              maxLength={120}
              autoFocus
              autoComplete="off"
              aria-describedby={describedBy}
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
              {(types ?? [client.type]).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          label="Note"
          hint="Optional. Leave it empty to take the note away."
          error={sending.errorFor('note')}
        >
          {({ id, describedBy }) => (
            <textarea
              id={id}
              value={note}
              rows={4}
              maxLength={2000}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>

        <Other problem={sending.other(['name', 'typeId', 'note'])} />
        <DialogFoot
          busy={sending.busy}
          disabled={name.trim() === ''}
          doing="Saving…"
          done="Save"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** Moving a client to somebody else with a role: a BD manager's alone. */
function OwnerDialog({
  client,
  onSaved,
  onClose,
  onSignedOut,
}: DialogProps & { client: ClientPage }) {
  const [people, setPeople] = useState<ClientsNamed[] | undefined>(undefined);
  const [ownerId, setOwnerId] = useState(client.owner.id);
  const sending = useSending(onSaved, onSignedOut);

  useEffect(() => {
    clientsHolders()
      .then(setPeople)
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [onSignedOut]);

  return (
    <Dialog
      title={`Move ${client.name}`}
      intro="Only people with a role in clients can look after a client."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => changeClient(client.id, { ownerId }));
        }}
      >
        <Field label="Owner" error={sending.errorFor('ownerId')}>
          {({ id, describedBy }) => (
            <select
              id={id}
              value={ownerId}
              aria-describedby={describedBy}
              disabled={sending.busy || people === undefined}
              onChange={(event) => {
                setOwnerId(event.target.value);
              }}
            >
              {(people ?? [client.owner]).map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Other problem={sending.other(['ownerId'])} />
        <DialogFoot
          busy={sending.busy}
          disabled={ownerId === client.owner.id}
          doing="Moving…"
          done="Move"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

const CONTACT_FIELDS = ['name', 'jobTitle', 'email', 'phone'] as const;

/** Adding a contact, or correcting one. Anybody with a role's. */
function ContactDialog({
  clientId,
  contact,
  onSaved,
  onClose,
  onSignedOut,
}: DialogProps & { clientId: string; contact?: ClientContact }) {
  const [details, setDetails] = useState<ContactDetails>({
    name: contact?.name ?? '',
    jobTitle: contact?.jobTitle ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
  });
  const sending = useSending(onSaved, onSignedOut);

  const labels: Record<(typeof CONTACT_FIELDS)[number], string> = {
    name: 'Name',
    jobTitle: 'Job title',
    email: 'Email',
    phone: 'Phone',
  };

  return (
    <Dialog
      title={contact === undefined ? 'Add a contact' : `Edit ${contact.name}`}
      intro="Only the name is needed. Anything left empty shows as missing, for somebody to fill in."
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            contact === undefined
              ? addContact(clientId, details)
              : changeContact(contact.id, details),
          );
        }}
      >
        {CONTACT_FIELDS.map((field) => (
          <Field key={field} label={labels[field]} error={sending.errorFor(field)}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'}
                value={details[field]}
                maxLength={field === 'email' ? 254 : field === 'phone' ? 40 : 120}
                autoFocus={field === 'name'}
                autoComplete="off"
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setDetails((was) => ({ ...was, [field]: event.target.value }));
                }}
              />
            )}
          </Field>
        ))}

        <Other problem={sending.other(CONTACT_FIELDS)} />
        <DialogFoot
          busy={sending.busy}
          disabled={details.name.trim() === ''}
          doing="Saving…"
          done={contact === undefined ? 'Add contact' : 'Save'}
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** A product the client already uses, from a day up to today. Anybody with a role's. */
function AddProductDialog({
  client,
  onSaved,
  onClose,
  onSignedOut,
}: DialogProps & { client: ClientPage }) {
  const [products, setProducts] = useState<ClientsOfferedProduct[] | undefined>(undefined);
  const [productId, setProductId] = useState('');
  const [sinceOn, setSinceOn] = useState('');
  const sending = useSending(onSaved, onSignedOut);

  useEffect(() => {
    offeredProducts()
      .then((found) => {
        /* Not what it has already: that is corrected where it is listed. */
        const choosable = found.filter(
          (product) => !client.products.some((one) => one.productId === product.id),
        );
        setProducts(choosable);
        setProductId(choosable[0]?.id ?? '');
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) onSignedOut();
      });
  }, [client.products, onSignedOut]);

  const lines = [...new Set((products ?? []).map((product) => product.lineName))];

  return (
    <Dialog
      title="Add a product in use"
      intro={`A product ${client.name} already uses, from the day it started.`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() => addProductInUse(client.id, productId, sinceOn));
        }}
      >
        {products !== undefined && products.length === 0 ? (
          <p className="muted">Every product on offer is already recorded for {client.name}.</p>
        ) : (
          <Field label="Product" error={sending.errorFor('productId')}>
            {({ id, describedBy }) => (
              <select
                id={id}
                value={productId}
                aria-describedby={describedBy}
                disabled={sending.busy || products === undefined}
                onChange={(event) => {
                  setProductId(event.target.value);
                }}
              >
                {lines.map((line) => (
                  <optgroup key={line} label={line}>
                    {(products ?? [])
                      .filter((product) => product.lineName === line)
                      .map((product) => (
                        <option key={product.id} value={product.id}>
                          {product.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
        )}

        <Field label="Using it since" error={sending.errorFor('sinceOn')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              type="date"
              value={sinceOn}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setSinceOn(event.target.value);
              }}
            />
          )}
        </Field>

        <Other problem={sending.other(['productId', 'sinceOn'])} />
        <DialogFoot
          busy={sending.busy}
          disabled={productId === '' || sinceOn === ''}
          doing="Adding…"
          done="Add product"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** When a client started using a product, and whether and when they stopped. */
function ProductDatesDialog({
  clientId,
  product,
  onSaved,
  onClose,
  onSignedOut,
}: DialogProps & { clientId: string; product: ClientProductInUse }) {
  const [sinceOn, setSinceOn] = useState(product.sinceOn);
  const [stopped, setStopped] = useState(product.endedOn !== null);
  const [endedOn, setEndedOn] = useState(product.endedOn ?? '');
  const sending = useSending(onSaved, onSignedOut);

  return (
    <Dialog title={product.productName} intro={product.lineName} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          sending.send(() =>
            changeProductInUse(clientId, product.productId, {
              sinceOn,
              endedOn: stopped ? endedOn : null,
            }),
          );
        }}
      >
        <Field label="Using it since" error={sending.errorFor('sinceOn')}>
          {({ id, describedBy }) => (
            <input
              id={id}
              type="date"
              value={sinceOn}
              aria-describedby={describedBy}
              disabled={sending.busy}
              onChange={(event) => {
                setSinceOn(event.target.value);
              }}
            />
          )}
        </Field>

        <label className="clients-check">
          <input
            type="checkbox"
            checked={stopped}
            disabled={sending.busy}
            onChange={(event) => {
              setStopped(event.target.checked);
            }}
          />
          They have stopped using it
        </label>

        {stopped ? (
          <Field label="Stopped on" error={sending.errorFor('endedOn')}>
            {({ id, describedBy }) => (
              <input
                id={id}
                type="date"
                value={endedOn}
                aria-describedby={describedBy}
                disabled={sending.busy}
                onChange={(event) => {
                  setEndedOn(event.target.value);
                }}
              />
            )}
          </Field>
        ) : null}

        <Other problem={sending.other(['sinceOn', 'endedOn'])} />
        <DialogFoot
          busy={sending.busy}
          disabled={sinceOn === '' || (stopped && endedOn === '')}
          doing="Saving…"
          done="Save"
          onCancel={onClose}
        />
      </form>
    </Dialog>
  );
}

/** A refusal about no field on the form, across its foot. */
function Other({ problem }: { problem: Problem | undefined }) {
  return problem === undefined ? null : <Notice problem={problem} />;
}
