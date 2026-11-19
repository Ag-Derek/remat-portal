import { useEffect, useState } from 'react';
import {
  type ClientsOfferedProduct,
  type ClientType,
  clientTypes,
  documentDownloadPath,
  isNotSignedIn,
  offeredProducts,
  type PastProposal,
  pastProposals,
} from '../../api';
import { day, money } from '../../format';
import { Notice, type Problem, problemFrom } from '../../problem';
import { sizeInWords } from './AttachFile';

/**
 * Past proposals and financials, at every client, the latest first. #281, Clients SRS CLI 66.
 *
 * Narrowed by the type of client and the product, so the last one written for a similar client,
 * a broker who wanted Federation say, is a filter away and its file one click from there to start
 * the next from. Proposals and financials both, or either. Anybody with a role sees every one.
 */
export function ProposalsView({ onSignedOut }: { onSignedOut: () => void }) {
  const [types, setTypes] = useState<ClientType[]>([]);
  const [products, setProducts] = useState<ClientsOfferedProduct[]>([]);
  const [typeId, setTypeId] = useState('');
  const [productId, setProductId] = useState('');
  const [kind, setKind] = useState<'' | 'PROPOSAL' | 'FINANCIALS'>('');
  const [proposals, setProposals] = useState<PastProposal[] | undefined>(undefined);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);

  /* The choices for the two filters. */
  useEffect(() => {
    Promise.all([clientTypes(), offeredProducts()])
      .then(([foundTypes, foundProducts]) => {
        setTypes(foundTypes);
        setProducts(foundProducts);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        setProblem(problemFrom(error));
      });
  }, [onSignedOut]);

  /* The list, again whenever a filter changes. */
  useEffect(() => {
    let current = true;

    pastProposals({ typeId, productId, kind })
      .then((found) => {
        if (current) {
          setProposals(found);
          setProblem(undefined);
        }
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }
        if (current) setProblem(problemFrom(error));
      });

    return () => {
      current = false;
    };
  }, [typeId, productId, kind, onSignedOut]);

  return (
    <section className="clients-list">
      <header className="clients-setup-head">
        <div>
          <h2>Past proposals</h2>
          <p className="muted">
            Every proposal and set of financials sent, the latest first. Open one to start the next
            from.
          </p>
        </div>
      </header>

      <div className="filter-bar">
        <label>
          <span className="visually-hidden">Type of client</span>
          <select
            value={typeId}
            onChange={(event) => {
              setTypeId(event.target.value);
            }}
          >
            <option value="">Every type of client</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Product</span>
          <select
            value={productId}
            onChange={(event) => {
              setProductId(event.target.value);
            }}
          >
            <option value="">Every product</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name} ({product.lineName})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Proposals or financials</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
            }}
          >
            <option value="">Proposals and financials</option>
            <option value="PROPOSAL">Proposals</option>
            <option value="FINANCIALS">Financials</option>
          </select>
        </label>
      </div>

      {problem === undefined ? null : <Notice problem={problem} />}

      {proposals === undefined ? null : proposals.length === 0 ? (
        <div className="notice plain">
          <p>
            {typeId === '' && productId === '' && kind === ''
              ? 'No proposal has been logged yet.'
              : 'None matches these. Try every type of client, or every product.'}
          </p>
        </div>
      ) : (
        <div className="directory-card">
          <table className="directory-table">
            <thead>
              <tr>
                <th scope="col">Sent</th>
                <th scope="col">Client</th>
                <th scope="col">Product</th>
                <th scope="col">What</th>
                <th scope="col">Files</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <tr key={proposal.id}>
                  <td>
                    {day(proposal.happenedOn)}
                    <br />
                    <small className="muted">{proposal.loggedBy.name}</small>
                  </td>
                  <td>
                    <a href={`#/clients/client/${proposal.client.id}`}>{proposal.client.name}</a>
                    <br />
                    <small className="muted">{proposal.client.type.name}</small>
                  </td>
                  <td>{proposal.deal.productName}</td>
                  <td>
                    {proposal.kind === 'PROPOSAL' ? 'Proposal' : 'Financials'}
                    {proposal.amount === null ? null : (
                      <>
                        <br />
                        <small>{money(proposal.amount)}</small>
                      </>
                    )}
                  </td>
                  <td>
                    {proposal.files.length === 0 ? (
                      <span className="muted">No file attached</span>
                    ) : (
                      proposal.files.map((file) => (
                        <div key={file.id}>
                          {file.downloadable ? (
                            <a href={documentDownloadPath(file.id)} download={file.filename}>
                              {file.filename}
                            </a>
                          ) : (
                            <span title="Waiting for its virus check">{file.filename}</span>
                          )}{' '}
                          <small className="muted">{sizeInWords(file.sizeBytes)}</small>
                        </div>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
