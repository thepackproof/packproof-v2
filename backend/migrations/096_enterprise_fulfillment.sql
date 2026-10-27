-- Enterprise read model. No consumer Proof table or lifecycle changes.
CREATE TABLE enterprise_sites (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES platform_organizations(id),
 name TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('SYNTHETIC','HISTORICAL')),
 fulfillment_mode TEXT NOT NULL CHECK(fulfillment_mode IN ('PICKUP','LOCAL_DELIVERY','CARRIER','TRANSFER')),
 approval_reference TEXT, retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650),
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(id,organization_id), CHECK(mode='SYNTHETIC' OR approval_reference IS NOT NULL)
);
CREATE TABLE enterprise_site_members (
 site_id TEXT NOT NULL REFERENCES enterprise_sites(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('ADMIN','IMPORTER','REVIEWER','READ_ONLY')), revoked_at TIMESTAMPTZ,
 PRIMARY KEY(site_id,user_id)
);
CREATE TABLE enterprise_sources (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES enterprise_sites(id), name TEXT NOT NULL,
 freshness_hours INTEGER NOT NULL CHECK(freshness_hours BETWEEN 1 AND 8760), created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(id,site_id), UNIQUE(site_id,name)
);
CREATE TABLE enterprise_mappings (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES enterprise_sources(id), version TEXT NOT NULL,
 dictionary JSONB NOT NULL, approved_by TEXT NOT NULL REFERENCES users(id), approval_reference TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, UNIQUE(source_id,version), UNIQUE(id,source_id)
);
CREATE TABLE enterprise_source_grants (
 source_id TEXT NOT NULL REFERENCES enterprise_sources(id), principal_id TEXT NOT NULL REFERENCES platform_principals(id),
 expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, PRIMARY KEY(source_id,principal_id)
);
CREATE TABLE enterprise_assets (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL, source_id TEXT NOT NULL, document_key TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 1048576),
 content_type TEXT NOT NULL, object_key TEXT NOT NULL, version_id TEXT, created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(source_id,site_id) REFERENCES enterprise_sources(id,site_id),
 UNIQUE(source_id,document_key,sha256), UNIQUE(id,source_id)
);
CREATE TABLE enterprise_imports (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL, source_id TEXT NOT NULL, mapping_id TEXT NOT NULL,
 original_asset_id TEXT NOT NULL REFERENCES enterprise_assets(id), manifest JSONB NOT NULL, manifest_sha256 TEXT NOT NULL,
 counts JSONB NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(source_id,site_id) REFERENCES enterprise_sources(id,site_id),
 FOREIGN KEY(mapping_id,source_id) REFERENCES enterprise_mappings(id,source_id)
);
CREATE TABLE enterprise_source_records (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES enterprise_sources(id), import_id TEXT NOT NULL REFERENCES enterprise_imports(id),
 record_key TEXT NOT NULL, revision TEXT NOT NULL, supersedes_revision TEXT, sha256 TEXT NOT NULL,
 raw_payload JSONB NOT NULL, normalized JSONB, errors JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(source_id,record_key,revision), UNIQUE(id,source_id)
);
CREATE TABLE enterprise_record_heads (
 source_id TEXT NOT NULL, record_key TEXT NOT NULL, record_id TEXT NOT NULL,
 PRIMARY KEY(source_id,record_key), FOREIGN KEY(record_id,source_id) REFERENCES enterprise_source_records(id,source_id)
);
CREATE TABLE enterprise_orders (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL, FOREIGN KEY(source_id,site_id) REFERENCES enterprise_sources(id,site_id),
 UNIQUE(source_id,external_id), UNIQUE(id,site_id)
);
CREATE TABLE enterprise_order_lines (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES enterprise_orders(id), external_id TEXT NOT NULL, UNIQUE(order_id,external_id)
);
CREATE TABLE enterprise_fulfillments (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
 FOREIGN KEY(source_id,site_id) REFERENCES enterprise_sources(id,site_id), UNIQUE(source_id,external_id)
);
CREATE TABLE enterprise_assertions (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES enterprise_source_records(id),
 order_line_id TEXT NOT NULL REFERENCES enterprise_order_lines(id), fulfillment_id TEXT REFERENCES enterprise_fulfillments(id),
 stage TEXT NOT NULL, quantity NUMERIC(24,6), uom TEXT, item_id TEXT,
 UNIQUE(record_id,order_line_id,stage,fulfillment_id)
);
CREATE INDEX enterprise_assertions_line ON enterprise_assertions(order_line_id,record_id);
CREATE TABLE enterprise_handling_units (
 id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES enterprise_sources(id), external_id TEXT NOT NULL, UNIQUE(source_id,external_id)
);
CREATE TABLE enterprise_handling_unit_lines (
 record_id TEXT NOT NULL REFERENCES enterprise_source_records(id), handling_unit_id TEXT NOT NULL REFERENCES enterprise_handling_units(id),
 order_line_id TEXT NOT NULL REFERENCES enterprise_order_lines(id), PRIMARY KEY(record_id,handling_unit_id,order_line_id)
);
CREATE TABLE enterprise_record_assets (
 record_id TEXT NOT NULL REFERENCES enterprise_source_records(id), asset_id TEXT NOT NULL REFERENCES enterprise_assets(id), PRIMARY KEY(record_id,asset_id)
);
CREATE TABLE enterprise_link_decisions (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES enterprise_source_records(id), order_id TEXT NOT NULL REFERENCES enterprise_orders(id),
 reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE enterprise_annotations (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES enterprise_orders(id), exception_key TEXT,
 disposition TEXT NOT NULL CHECK(disposition IN ('NOTE','EXPLAINED','EXPECTED','NEEDS_FOLLOW_UP')),
 reason TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE enterprise_measurements (
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES enterprise_orders(id), study_key TEXT NOT NULL,
 condition TEXT NOT NULL CHECK(condition IN ('BASELINE','PACKPROOF')), complexity TEXT NOT NULL,
 question TEXT NOT NULL, reviewer_id TEXT NOT NULL REFERENCES users(id), started_at TIMESTAMPTZ NOT NULL,
 UNIQUE(order_id,study_key,condition,reviewer_id)
);
CREATE TABLE enterprise_measurement_results (
 measurement_id TEXT PRIMARY KEY REFERENCES enterprise_measurements(id), duration_seconds NUMERIC NOT NULL CHECK(duration_seconds>=0),
 outcome TEXT NOT NULL CHECK(outcome IN ('COMPLETED','INCOMPLETE')), correct_links INTEGER NOT NULL CHECK(correct_links>=0),
 adjudicated_links INTEGER NOT NULL CHECK(adjudicated_links>=correct_links), missing_visible INTEGER NOT NULL CHECK(missing_visible>=0),
 known_missing INTEGER NOT NULL CHECK(known_missing>=missing_visible), feedback TEXT NOT NULL, completed_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE enterprise_audit (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES enterprise_sites(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 principal_id TEXT REFERENCES platform_principals(id), request_id TEXT NOT NULL, operation TEXT NOT NULL, resource_id TEXT,
 details JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX enterprise_audit_site ON enterprise_audit(site_id,created_at,id);
CREATE TRIGGER enterprise_mappings_immutable BEFORE UPDATE OR DELETE ON enterprise_mappings FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_imports_immutable BEFORE UPDATE OR DELETE ON enterprise_imports FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_source_records_immutable BEFORE UPDATE OR DELETE ON enterprise_source_records FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_assets_immutable BEFORE UPDATE OR DELETE ON enterprise_assets FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_assertions_immutable BEFORE UPDATE OR DELETE ON enterprise_assertions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_annotations_immutable BEFORE UPDATE OR DELETE ON enterprise_annotations FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_link_decisions_immutable BEFORE UPDATE OR DELETE ON enterprise_link_decisions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_measurements_immutable BEFORE UPDATE OR DELETE ON enterprise_measurements FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_measurement_results_immutable BEFORE UPDATE OR DELETE ON enterprise_measurement_results FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER enterprise_audit_immutable BEFORE UPDATE OR DELETE ON enterprise_audit FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
