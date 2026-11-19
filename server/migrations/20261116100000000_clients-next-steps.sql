-- Up Migration

-- What happens next and by when, and whose it is. Clients SRS CLI 53, CLI 63, CLI 64, TDD 4.5.
--
-- Made now, ahead of the rest of #280 (activities and next steps), for its first writer: the
-- internal debrief a POC exit gives the BD managers, due five working days later (CLI 53, #279).
-- Its other columns join it with the tables they point at: poc_id with the POC (#285, and the
-- review kind with the review meetings it is for, CLI 33), from_activity with activities (#280).
-- Closing one, done_at and done_by, is granted with the screen that closes it (#280, CLI 64).

CREATE TABLE clients_next_step (
    id              BIGSERIAL PRIMARY KEY,
    client_id       BIGINT NOT NULL REFERENCES clients_client(id),
    /* The deal it is about, where it is about one. */
    opportunity_id  BIGINT REFERENCES clients_opportunity(id),

    description     VARCHAR(300) NOT NULL,
    due_on          DATE NOT NULL,
    owner_id        BIGINT NOT NULL REFERENCES employee(id),

    /* What made it: an activity logged with one (CLI 63), a POC review (CLI 33), an exit's
       debrief (CLI 53), or somebody adding one on its own. */
    source          VARCHAR(10) NOT NULL,

    /* Closed by its owner when it is done, and never by itself (CLI 64). */
    done_at         TIMESTAMPTZ,
    done_by         BIGINT REFERENCES employee(id),

    created_by      BIGINT NOT NULL REFERENCES employee(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT clients_next_step_source_known
        CHECK (source IN ('ACTIVITY', 'REVIEW', 'DEBRIEF', 'MANUAL')),
    /* TDD's step_done_pair. */
    CONSTRAINT clients_next_step_done_pair CHECK ((done_at IS NULL) = (done_by IS NULL)),
    CONSTRAINT clients_next_step_described CHECK (btrim(description) <> ''),
    /* Beyond TDD 4.5: a debrief is about the deal that was exited. */
    CONSTRAINT clients_next_step_debrief_names_its_deal
        CHECK (source <> 'DEBRIEF' OR opportunity_id IS NOT NULL)
);

/* TDD's idx_step_open: somebody's open steps by when they fall due, which My pipeline and the
   daily run ask for (CLI 71, CLI 97). */
CREATE INDEX idx_clients_next_step_open ON clients_next_step (owner_id, due_on)
    WHERE done_at IS NULL;

/* A client's and a deal's steps, which their pages ask for. */
CREATE INDEX idx_clients_next_step_client ON clients_next_step (client_id);
CREATE INDEX idx_clients_next_step_deal ON clients_next_step (opportunity_id)
    WHERE opportunity_id IS NOT NULL;

-- ---------------------------------------------------------------------------- privileges

/* Default privileges give lms_app SELECT and INSERT, and USAGE on the sequence. Nothing is
   updated until closing a step is built (#280), and nothing is deleted. */

-- Down Migration

DROP TABLE IF EXISTS clients_next_step;
