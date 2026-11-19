-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "material_granularity_enum" AS ENUM ('BUNDLE', 'BATCH', 'PIECE');

-- CreateEnum
CREATE TYPE "material_classification_enum" AS ENUM ('ORIGINAL', 'PENDING_RECONCILIATION', 'PREPARED', 'OFFCUT', 'SCRAP');

-- CreateEnum
CREATE TYPE "material_status_enum" AS ENUM ('AVAILABLE', 'RESERVED', 'CONSUMED', 'DISPATCHED', 'INSTALLED', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "reconciliation_status_enum" AS ENUM ('UNRECONCILED', 'BALANCED', 'ADJUSTED');

-- CreateEnum
CREATE TYPE "attribution_mode_enum" AS ENUM ('EXACT', 'KNOWN_PARTIAL', 'POOLED');

-- CreateEnum
CREATE TYPE "measurement_basis_enum" AS ENUM ('LENGTH', 'WEIGHT');

-- CreateEnum
CREATE TYPE "adjustment_type_enum" AS ENUM ('TOLERANCE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "transfer_status_enum" AS ENUM ('DISPATCHED', 'PARTIALLY_RECEIVED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "location_type_enum" AS ENUM ('WAREHOUSE', 'PROCESSING_AREA', 'SITE', 'OTHER');

-- CreateEnum
CREATE TYPE "record_status_enum" AS ENUM ('ACTIVE', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "release_type_enum" AS ENUM ('FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "receipt_disposition_enum" AS ENUM ('ACCEPTED', 'ON_HOLD', 'DAMAGED_DISCREPANT');

-- CreateEnum
CREATE TYPE "invitation_status_enum" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "bundle_origin_type_enum" AS ENUM ('OPENING_STOCK', 'GRN_PURCHASE');

-- CreateEnum
CREATE TYPE "rebar_surface_type_enum" AS ENUM ('DEFORMED', 'PLAIN');

-- CreateTable
CREATE TABLE "companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "auth_provider" TEXT NOT NULL,
    "auth_provider_subject_id" TEXT,
    "password_hash" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ(6),
    "deactivated_by_membership_id" UUID,

    CONSTRAINT "company_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "invited_email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "invited_by_membership_id" UUID NOT NULL,
    "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "status" "invitation_status_enum" NOT NULL DEFAULT 'PENDING',
    "token_hash" TEXT NOT NULL,
    "accepted_user_id" UUID,
    "accepted_at" TIMESTAMPTZ(6),

    CONSTRAINT "company_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "building_type" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_locations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID,
    "location_type" "location_type_enum" NOT NULL,
    "name" TEXT NOT NULL,
    "parent_storage_location_id" UUID,
    "zone_code" TEXT,
    "rack_code" TEXT,
    "bay_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_node_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "location_node_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_nodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "parent_id" UUID,
    "location_node_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "location_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manufacturers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,

    CONSTRAINT "manufacturers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "structural_element_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "structural_element_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reinforcement_purposes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "reinforcement_purposes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_operation_types" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "requires_uniform_input_spec" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "processing_operation_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "structural_element_instances" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "structural_element_type_id" UUID NOT NULL,
    "location_node_id" UUID NOT NULL,
    "reference_code" TEXT NOT NULL,

    CONSTRAINT "structural_element_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rebar_catalog_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "item_code" TEXT NOT NULL,
    "diameter_mm" DECIMAL(6,2) NOT NULL,
    "surface_type" "rebar_surface_type_enum" NOT NULL DEFAULT 'DEFORMED',
    "default_grade" TEXT,
    "default_standard" TEXT,
    "standard_bar_length_m" DECIMAL(10,3),
    "default_pieces_per_bundle" INTEGER,
    "linear_density_kg_per_m" DECIMAL(8,4) NOT NULL,
    "reorder_threshold_mt" DECIMAL(10,3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rebar_catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shape_codes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active_dimensions" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "shape_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID,
    "internal_reference_code" TEXT NOT NULL,
    "supplier_id" UUID,
    "manufacturer_id" UUID,
    "country_of_origin" TEXT,
    "diameter_mm" DECIMAL(6,2) NOT NULL,
    "grade" TEXT NOT NULL,
    "grade_normalized" TEXT NOT NULL,
    "standard" TEXT,
    "standard_normalized" TEXT,
    "heat_number" TEXT,
    "piece_count" INTEGER NOT NULL,
    "bar_length_m" DECIMAL(10,3) NOT NULL,
    "surface_type" "rebar_surface_type_enum" NOT NULL DEFAULT 'DEFORMED',
    "origin_type" "bundle_origin_type_enum" NOT NULL,
    "grn_reference" TEXT,
    "po_reference" TEXT,
    "delivery_note_number" TEXT,
    "vehicle_info" TEXT,
    "weighbridge_ticket_number" TEXT,
    "mtc_reference" TEXT,
    "actual_weight_kg" DECIMAL(10,3),
    "initial_disposition" "receipt_disposition_enum" NOT NULL DEFAULT 'ACCEPTED',
    "approved_by_membership_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "registered_by_membership_id" UUID NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_attribute_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,

    CONSTRAINT "bundle_attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bundle_attribute_values" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "bundle_attribute_definition_id" UUID NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL,
    "value_date" DATE,

    CONSTRAINT "bundle_attribute_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_units" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID,
    "source_bundle_id" UUID,
    "granularity" "material_granularity_enum" NOT NULL,
    "classification" "material_classification_enum" NOT NULL,
    "status" "material_status_enum" NOT NULL,
    "diameter_mm" DECIMAL(6,2) NOT NULL,
    "grade" TEXT NOT NULL,
    "grade_normalized" TEXT NOT NULL,
    "standard" TEXT,
    "standard_normalized" TEXT,
    "surface_type" "rebar_surface_type_enum" NOT NULL,
    "quantity_pieces" INTEGER NOT NULL,
    "unit_length_m" DECIMAL(10,3),
    "total_length_m" DECIMAL(10,3) NOT NULL,
    "unit_weight_kg" DECIMAL(10,3),
    "total_weight_kg" DECIMAL(10,3),
    "internal_reference_code" TEXT,
    "current_storage_location_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_unit_origins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "bundle_id" UUID NOT NULL,
    "contribution_weight" DECIMAL(6,5),
    "confidence" "attribution_mode_enum" NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_unit_origins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "from_project_id" UUID,
    "to_project_id" UUID,
    "quantity_pieces" INTEGER NOT NULL,
    "length_m" DECIMAL(10,3) NOT NULL,
    "allocated_by_membership_id" UUID NOT NULL,
    "allocated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "project_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "reference_code" TEXT NOT NULL,
    "description" TEXT,
    "bbs_line_id" UUID,
    "created_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_operations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "work_order_id" UUID,
    "reference_code" TEXT NOT NULL,
    "operation_type_id" UUID NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "performed_by_membership_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_by_membership_id" UUID,
    "checked_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT,
    "reconciliation_status" "reconciliation_status_enum" NOT NULL DEFAULT 'UNRECONCILED',
    "is_finalized" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "processing_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_inputs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "processing_operation_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "quantity_consumed_pieces" INTEGER NOT NULL,
    "length_consumed_m" DECIMAL(10,3) NOT NULL,
    "weight_consumed_kg" DECIMAL(10,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_outputs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "processing_operation_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "attribution_mode" "attribution_mode_enum" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_output_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "processing_output_id" UUID NOT NULL,
    "processing_input_id" UUID NOT NULL,
    "contribution_weight" DECIMAL(6,5),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_output_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_splits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "source_material_unit_id" UUID NOT NULL,
    "resulting_material_unit_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_by_membership_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "intended_usage_declaration_id" UUID,
    "bbs_line_id" UUID,
    "reserved_by_membership_id" UUID NOT NULL,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "released_by_membership_id" UUID,
    "release_type" "release_type_enum",
    "release_reason" TEXT,

    CONSTRAINT "material_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_hold_releases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "released_by_membership_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,

    CONSTRAINT "material_hold_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conservation_adjustments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "processing_operation_id" UUID,
    "material_transfer_line_id" UUID,
    "physical_stock_count_line_id" UUID,
    "measurement_basis" "measurement_basis_enum" NOT NULL,
    "amount" DECIMAL(10,3) NOT NULL,
    "adjustment_type" "adjustment_type_enum" NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_by_membership_id" UUID NOT NULL,
    "approved_by_membership_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conservation_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intended_usage_declarations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "processing_operation_id" UUID,
    "processing_output_id" UUID,
    "structural_element_type_id" UUID,
    "structural_element_instance_id" UUID,
    "location_node_id" UUID,
    "reinforcement_purpose_id" UUID NOT NULL,
    "bbs_line_id" UUID,
    "declared_by_membership_id" UUID NOT NULL,
    "declared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "record_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "supersedes_id" UUID,

    CONSTRAINT "intended_usage_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reclassification_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "from_classification" "material_classification_enum" NOT NULL,
    "to_classification" "material_classification_enum" NOT NULL,
    "reason" TEXT NOT NULL,
    "recorded_by_membership_id" UUID NOT NULL,
    "approved_by_membership_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reclassification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bbs_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "reference_code" TEXT NOT NULL,
    "drawing_number" TEXT,
    "drawing_revision" TEXT,
    "wastage_allowance_pct" DECIMAL(5,2),
    "status" "record_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "prepared_by_membership_id" UUID NOT NULL,
    "approved_by_membership_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bbs_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bbs_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "bbs_schedule_id" UUID NOT NULL,
    "structural_element_type_id" UUID,
    "structural_element_instance_id" UUID,
    "location_node_id" UUID,
    "reinforcement_purpose_id" UUID NOT NULL,
    "bar_mark" TEXT NOT NULL,
    "diameter_mm" DECIMAL(6,2) NOT NULL,
    "surface_type" "rebar_surface_type_enum" NOT NULL DEFAULT 'DEFORMED',
    "grade_normalized" TEXT NOT NULL,
    "shape_code_id" UUID NOT NULL,
    "dim_a_mm" DECIMAL(8,2),
    "dim_b_mm" DECIMAL(8,2),
    "dim_c_mm" DECIMAL(8,2),
    "dim_d_mm" DECIMAL(8,2),
    "dim_e_mm" DECIMAL(8,2),
    "dim_r_mm" DECIMAL(8,2),
    "cut_length_m" DECIMAL(10,3) NOT NULL,
    "bars_per_member" INTEGER NOT NULL,
    "member_count" INTEGER NOT NULL,
    "total_bars_required" INTEGER NOT NULL,

    CONSTRAINT "bbs_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_stock_counts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "reference_code" TEXT NOT NULL,
    "count_date" DATE NOT NULL,
    "status" "record_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "counted_by_membership_id" UUID NOT NULL,
    "verified_by_membership_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "physical_stock_counts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "physical_stock_count_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "physical_stock_count_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "system_pieces" INTEGER NOT NULL,
    "system_length_m" DECIMAL(10,3) NOT NULL,
    "counted_pieces" INTEGER NOT NULL,
    "counted_length_m" DECIMAL(10,3) NOT NULL,
    "variance_length_m" DECIMAL(10,3) NOT NULL,
    "investigation_notes" TEXT,

    CONSTRAINT "physical_stock_count_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_transfers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "from_location_id" UUID NOT NULL,
    "to_location_id" UUID NOT NULL,
    "status" "transfer_status_enum" NOT NULL DEFAULT 'DISPATCHED',
    "dispatched_by_membership_id" UUID NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicle_info" TEXT,
    "idempotency_key" TEXT,
    "reconciliation_status" "reconciliation_status_enum" NOT NULL DEFAULT 'UNRECONCILED',

    CONSTRAINT "material_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_transfer_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_transfer_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "split_from_material_unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_transfer_receipts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_transfer_id" UUID NOT NULL,
    "received_by_membership_id" UUID NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "material_transfer_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_transfer_receipt_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "material_transfer_receipt_id" UUID NOT NULL,
    "material_transfer_line_id" UUID NOT NULL,
    "resulting_material_unit_id" UUID NOT NULL,
    "disposition" "receipt_disposition_enum" NOT NULL DEFAULT 'ACCEPTED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_transfer_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "structural_element_instance_id" UUID NOT NULL,
    "reinforcement_purpose_id" UUID NOT NULL,
    "intended_usage_declaration_id" UUID,
    "bbs_line_id" UUID,
    "installed_by_membership_id" UUID NOT NULL,
    "installed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_by_membership_id" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "status" "record_status_enum" NOT NULL DEFAULT 'ACTIVE',
    "supersedes_id" UUID,
    "notes" TEXT,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installation_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "installation_id" UUID NOT NULL,
    "material_unit_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "installation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "target_table" TEXT NOT NULL,
    "target_record_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "uploaded_by_membership_id" UUID NOT NULL,
    "uploaded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "table_name" TEXT NOT NULL,
    "record_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by_membership_id" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "company_memberships_company_id_user_id_key" ON "company_memberships"("company_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_memberships_company_id_id_key" ON "company_memberships"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "company_invitations_company_id_id_key" ON "company_invitations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_company_id_name_key" ON "roles"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "roles_company_id_id_key" ON "roles"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_company_id_id_key" ON "projects"("company_id", "id");

-- CreateIndex
CREATE INDEX "storage_locations_company_id_project_id_idx" ON "storage_locations"("company_id", "project_id");

-- CreateIndex
CREATE INDEX "storage_locations_company_id_parent_storage_location_id_idx" ON "storage_locations"("company_id", "parent_storage_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "storage_locations_company_id_id_key" ON "storage_locations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "location_node_types_company_id_name_key" ON "location_node_types"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "location_node_types_company_id_id_key" ON "location_node_types"("company_id", "id");

-- CreateIndex
CREATE INDEX "location_nodes_company_id_project_id_parent_id_idx" ON "location_nodes"("company_id", "project_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_nodes_company_id_id_key" ON "location_nodes"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_company_id_id_key" ON "suppliers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "manufacturers_company_id_id_key" ON "manufacturers"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "structural_element_types_company_id_name_key" ON "structural_element_types"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "structural_element_types_company_id_id_key" ON "structural_element_types"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reinforcement_purposes_company_id_name_key" ON "reinforcement_purposes"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "reinforcement_purposes_company_id_id_key" ON "reinforcement_purposes"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_operation_types_company_id_name_key" ON "processing_operation_types"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "processing_operation_types_company_id_id_key" ON "processing_operation_types"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "structural_element_instances_company_id_project_id_referenc_key" ON "structural_element_instances"("company_id", "project_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "structural_element_instances_company_id_id_key" ON "structural_element_instances"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "rebar_catalog_items_company_id_item_code_key" ON "rebar_catalog_items"("company_id", "item_code");

-- CreateIndex
CREATE UNIQUE INDEX "rebar_catalog_items_company_id_id_key" ON "rebar_catalog_items"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "shape_codes_company_id_code_key" ON "shape_codes"("company_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "shape_codes_company_id_id_key" ON "shape_codes"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_company_id_internal_reference_code_key" ON "bundles"("company_id", "internal_reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "bundles_company_id_id_key" ON "bundles"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_attribute_definitions_company_id_name_key" ON "bundle_attribute_definitions"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_attribute_definitions_company_id_id_key" ON "bundle_attribute_definitions"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_attribute_values_company_id_bundle_id_bundle_attribu_key" ON "bundle_attribute_values"("company_id", "bundle_id", "bundle_attribute_definition_id");

-- CreateIndex
CREATE UNIQUE INDEX "bundle_attribute_values_company_id_id_key" ON "bundle_attribute_values"("company_id", "id");

-- CreateIndex
CREATE INDEX "material_units_company_id_project_id_status_idx" ON "material_units"("company_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "material_units_company_id_project_id_classification_idx" ON "material_units"("company_id", "project_id", "classification");

-- CreateIndex
CREATE INDEX "material_units_source_bundle_id_idx" ON "material_units"("source_bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_units_company_id_id_key" ON "material_units"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "material_units_company_id_internal_reference_code_key" ON "material_units"("company_id", "internal_reference_code");

-- CreateIndex
CREATE INDEX "material_unit_origins_company_id_bundle_id_idx" ON "material_unit_origins"("company_id", "bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_unit_origins_company_id_material_unit_id_bundle_id_key" ON "material_unit_origins"("company_id", "material_unit_id", "bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_unit_origins_company_id_id_key" ON "material_unit_origins"("company_id", "id");

-- CreateIndex
CREATE INDEX "project_allocations_company_id_material_unit_id_allocated_a_idx" ON "project_allocations"("company_id", "material_unit_id", "allocated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "project_allocations_company_id_id_key" ON "project_allocations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_company_id_project_id_reference_code_key" ON "work_orders"("company_id", "project_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_company_id_id_key" ON "work_orders"("company_id", "id");

-- CreateIndex
CREATE INDEX "processing_operations_company_id_project_id_performed_at_idx" ON "processing_operations"("company_id", "project_id", "performed_at");

-- CreateIndex
CREATE INDEX "processing_operations_company_id_work_order_id_idx" ON "processing_operations"("company_id", "work_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_operations_company_id_reference_code_key" ON "processing_operations"("company_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "processing_operations_company_id_id_key" ON "processing_operations"("company_id", "id");

-- CreateIndex
CREATE INDEX "processing_inputs_company_id_material_unit_id_idx" ON "processing_inputs"("company_id", "material_unit_id");

-- CreateIndex
CREATE INDEX "processing_inputs_company_id_processing_operation_id_idx" ON "processing_inputs"("company_id", "processing_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_inputs_company_id_id_key" ON "processing_inputs"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_outputs_company_id_material_unit_id_key" ON "processing_outputs"("company_id", "material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_outputs_company_id_id_key" ON "processing_outputs"("company_id", "id");

-- CreateIndex
CREATE INDEX "processing_output_sources_company_id_processing_output_id_idx" ON "processing_output_sources"("company_id", "processing_output_id");

-- CreateIndex
CREATE INDEX "processing_output_sources_company_id_processing_input_id_idx" ON "processing_output_sources"("company_id", "processing_input_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_output_sources_company_id_processing_output_id_p_key" ON "processing_output_sources"("company_id", "processing_output_id", "processing_input_id");

-- CreateIndex
CREATE UNIQUE INDEX "processing_output_sources_company_id_id_key" ON "processing_output_sources"("company_id", "id");

-- CreateIndex
CREATE INDEX "material_splits_company_id_source_material_unit_id_idx" ON "material_splits"("company_id", "source_material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_splits_company_id_resulting_material_unit_id_key" ON "material_splits"("company_id", "resulting_material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_splits_company_id_id_key" ON "material_splits"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "material_reservations_company_id_id_key" ON "material_reservations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "material_hold_releases_company_id_material_unit_id_key" ON "material_hold_releases"("company_id", "material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_hold_releases_company_id_id_key" ON "material_hold_releases"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "conservation_adjustments_company_id_id_key" ON "conservation_adjustments"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intended_usage_declarations_company_id_id_key" ON "intended_usage_declarations"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reclassification_events_company_id_id_key" ON "reclassification_events"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "bbs_schedules_company_id_project_id_reference_code_key" ON "bbs_schedules"("company_id", "project_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "bbs_schedules_company_id_id_key" ON "bbs_schedules"("company_id", "id");

-- CreateIndex
CREATE INDEX "bbs_lines_company_id_bbs_schedule_id_idx" ON "bbs_lines"("company_id", "bbs_schedule_id");

-- CreateIndex
CREATE INDEX "bbs_lines_company_id_shape_code_id_idx" ON "bbs_lines"("company_id", "shape_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "bbs_lines_company_id_id_key" ON "bbs_lines"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "physical_stock_counts_company_id_reference_code_key" ON "physical_stock_counts"("company_id", "reference_code");

-- CreateIndex
CREATE UNIQUE INDEX "physical_stock_counts_company_id_id_key" ON "physical_stock_counts"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "physical_stock_count_lines_company_id_physical_stock_count__key" ON "physical_stock_count_lines"("company_id", "physical_stock_count_id", "material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "physical_stock_count_lines_company_id_id_key" ON "physical_stock_count_lines"("company_id", "id");

-- CreateIndex
CREATE INDEX "material_transfers_company_id_project_id_status_dispatched__idx" ON "material_transfers"("company_id", "project_id", "status", "dispatched_at");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfers_company_id_id_key" ON "material_transfers"("company_id", "id");

-- CreateIndex
CREATE INDEX "material_transfer_lines_company_id_split_from_material_unit_idx" ON "material_transfer_lines"("company_id", "split_from_material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfer_lines_company_id_material_unit_id_key" ON "material_transfer_lines"("company_id", "material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfer_lines_company_id_id_key" ON "material_transfer_lines"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfer_receipts_company_id_id_key" ON "material_transfer_receipts"("company_id", "id");

-- CreateIndex
CREATE INDEX "material_transfer_receipt_lines_company_id_material_transfe_idx" ON "material_transfer_receipt_lines"("company_id", "material_transfer_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfer_receipt_lines_company_id_resulting_materi_key" ON "material_transfer_receipt_lines"("company_id", "resulting_material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "material_transfer_receipt_lines_company_id_id_key" ON "material_transfer_receipt_lines"("company_id", "id");

-- CreateIndex
CREATE INDEX "installations_company_id_project_id_installed_at_idx" ON "installations"("company_id", "project_id", "installed_at");

-- CreateIndex
CREATE INDEX "installations_company_id_structural_element_instance_id_idx" ON "installations"("company_id", "structural_element_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "installations_company_id_id_key" ON "installations"("company_id", "id");

-- CreateIndex
CREATE INDEX "installation_lines_company_id_material_unit_id_idx" ON "installation_lines"("company_id", "material_unit_id");

-- CreateIndex
CREATE INDEX "installation_lines_company_id_installation_id_idx" ON "installation_lines"("company_id", "installation_id");

-- CreateIndex
CREATE UNIQUE INDEX "installation_lines_company_id_installation_id_material_unit_key" ON "installation_lines"("company_id", "installation_id", "material_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "installation_lines_company_id_id_key" ON "installation_lines"("company_id", "id");

-- CreateIndex
CREATE INDEX "attachments_company_id_target_table_target_record_id_idx" ON "attachments"("company_id", "target_table", "target_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_company_id_id_key" ON "attachments"("company_id", "id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_table_name_record_id_idx" ON "audit_log"("company_id", "table_name", "record_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_company_id_id_key" ON "audit_log"("company_id", "id");

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_role_id_fkey" FOREIGN KEY ("company_id", "role_id") REFERENCES "roles"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_memberships" ADD CONSTRAINT "company_memberships_company_id_deactivated_by_membership_i_fkey" FOREIGN KEY ("company_id", "deactivated_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_role_id_fkey" FOREIGN KEY ("company_id", "role_id") REFERENCES "roles"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_company_id_invited_by_membership_id_fkey" FOREIGN KEY ("company_id", "invited_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "company_invitations" ADD CONSTRAINT "company_invitations_accepted_user_id_fkey" FOREIGN KEY ("accepted_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "storage_locations" ADD CONSTRAINT "storage_locations_company_id_parent_storage_location_id_fkey" FOREIGN KEY ("company_id", "parent_storage_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "location_node_types" ADD CONSTRAINT "location_node_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "location_nodes" ADD CONSTRAINT "location_nodes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "location_nodes" ADD CONSTRAINT "location_nodes_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "location_nodes" ADD CONSTRAINT "location_nodes_company_id_parent_id_fkey" FOREIGN KEY ("company_id", "parent_id") REFERENCES "location_nodes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "location_nodes" ADD CONSTRAINT "location_nodes_company_id_location_node_type_id_fkey" FOREIGN KEY ("company_id", "location_node_type_id") REFERENCES "location_node_types"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "manufacturers" ADD CONSTRAINT "manufacturers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "structural_element_types" ADD CONSTRAINT "structural_element_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reinforcement_purposes" ADD CONSTRAINT "reinforcement_purposes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operation_types" ADD CONSTRAINT "processing_operation_types_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "structural_element_instances" ADD CONSTRAINT "structural_element_instances_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "structural_element_instances" ADD CONSTRAINT "structural_element_instances_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "structural_element_instances" ADD CONSTRAINT "structural_element_instances_company_id_structural_element_fkey" FOREIGN KEY ("company_id", "structural_element_type_id") REFERENCES "structural_element_types"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "structural_element_instances" ADD CONSTRAINT "structural_element_instances_company_id_location_node_id_fkey" FOREIGN KEY ("company_id", "location_node_id") REFERENCES "location_nodes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "rebar_catalog_items" ADD CONSTRAINT "rebar_catalog_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "shape_codes" ADD CONSTRAINT "shape_codes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_supplier_id_fkey" FOREIGN KEY ("company_id", "supplier_id") REFERENCES "suppliers"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_manufacturer_id_fkey" FOREIGN KEY ("company_id", "manufacturer_id") REFERENCES "manufacturers"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_registered_by_membership_id_fkey" FOREIGN KEY ("company_id", "registered_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_company_id_approved_by_membership_id_fkey" FOREIGN KEY ("company_id", "approved_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundle_attribute_definitions" ADD CONSTRAINT "bundle_attribute_definitions_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundle_attribute_values" ADD CONSTRAINT "bundle_attribute_values_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundle_attribute_values" ADD CONSTRAINT "bundle_attribute_values_company_id_bundle_id_fkey" FOREIGN KEY ("company_id", "bundle_id") REFERENCES "bundles"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bundle_attribute_values" ADD CONSTRAINT "bundle_attribute_values_company_id_bundle_attribute_defini_fkey" FOREIGN KEY ("company_id", "bundle_attribute_definition_id") REFERENCES "bundle_attribute_definitions"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_units" ADD CONSTRAINT "material_units_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_units" ADD CONSTRAINT "material_units_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_units" ADD CONSTRAINT "material_units_company_id_source_bundle_id_fkey" FOREIGN KEY ("company_id", "source_bundle_id") REFERENCES "bundles"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_units" ADD CONSTRAINT "material_units_company_id_current_storage_location_id_fkey" FOREIGN KEY ("company_id", "current_storage_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_unit_origins" ADD CONSTRAINT "material_unit_origins_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_unit_origins" ADD CONSTRAINT "material_unit_origins_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_unit_origins" ADD CONSTRAINT "material_unit_origins_company_id_bundle_id_fkey" FOREIGN KEY ("company_id", "bundle_id") REFERENCES "bundles"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_company_id_from_project_id_fkey" FOREIGN KEY ("company_id", "from_project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_company_id_to_project_id_fkey" FOREIGN KEY ("company_id", "to_project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "project_allocations" ADD CONSTRAINT "project_allocations_company_id_allocated_by_membership_id_fkey" FOREIGN KEY ("company_id", "allocated_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_bbs_line_id_fkey" FOREIGN KEY ("company_id", "bbs_line_id") REFERENCES "bbs_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_company_id_created_by_membership_id_fkey" FOREIGN KEY ("company_id", "created_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_work_order_id_fkey" FOREIGN KEY ("company_id", "work_order_id") REFERENCES "work_orders"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_operation_type_id_fkey" FOREIGN KEY ("company_id", "operation_type_id") REFERENCES "processing_operation_types"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_storage_location_id_fkey" FOREIGN KEY ("company_id", "storage_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_performed_by_membership_i_fkey" FOREIGN KEY ("company_id", "performed_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_operations" ADD CONSTRAINT "processing_operations_company_id_checked_by_membership_id_fkey" FOREIGN KEY ("company_id", "checked_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_inputs" ADD CONSTRAINT "processing_inputs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_inputs" ADD CONSTRAINT "processing_inputs_company_id_processing_operation_id_fkey" FOREIGN KEY ("company_id", "processing_operation_id") REFERENCES "processing_operations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_inputs" ADD CONSTRAINT "processing_inputs_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_outputs" ADD CONSTRAINT "processing_outputs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_outputs" ADD CONSTRAINT "processing_outputs_company_id_processing_operation_id_fkey" FOREIGN KEY ("company_id", "processing_operation_id") REFERENCES "processing_operations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_outputs" ADD CONSTRAINT "processing_outputs_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_output_sources" ADD CONSTRAINT "processing_output_sources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_output_sources" ADD CONSTRAINT "processing_output_sources_company_id_processing_output_id_fkey" FOREIGN KEY ("company_id", "processing_output_id") REFERENCES "processing_outputs"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "processing_output_sources" ADD CONSTRAINT "processing_output_sources_company_id_processing_input_id_fkey" FOREIGN KEY ("company_id", "processing_input_id") REFERENCES "processing_inputs"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_splits" ADD CONSTRAINT "material_splits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_splits" ADD CONSTRAINT "material_splits_company_id_source_material_unit_id_fkey" FOREIGN KEY ("company_id", "source_material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_splits" ADD CONSTRAINT "material_splits_company_id_resulting_material_unit_id_fkey" FOREIGN KEY ("company_id", "resulting_material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_splits" ADD CONSTRAINT "material_splits_company_id_recorded_by_membership_id_fkey" FOREIGN KEY ("company_id", "recorded_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_intended_usage_declaratio_fkey" FOREIGN KEY ("company_id", "intended_usage_declaration_id") REFERENCES "intended_usage_declarations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_bbs_line_id_fkey" FOREIGN KEY ("company_id", "bbs_line_id") REFERENCES "bbs_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_reserved_by_membership_id_fkey" FOREIGN KEY ("company_id", "reserved_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_reservations" ADD CONSTRAINT "material_reservations_company_id_released_by_membership_id_fkey" FOREIGN KEY ("company_id", "released_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_hold_releases" ADD CONSTRAINT "material_hold_releases_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_hold_releases" ADD CONSTRAINT "material_hold_releases_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_hold_releases" ADD CONSTRAINT "material_hold_releases_company_id_released_by_membership_i_fkey" FOREIGN KEY ("company_id", "released_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_processing_operation_i_fkey" FOREIGN KEY ("company_id", "processing_operation_id") REFERENCES "processing_operations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_material_transfer_line_fkey" FOREIGN KEY ("company_id", "material_transfer_line_id") REFERENCES "material_transfer_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_physical_stock_count_l_fkey" FOREIGN KEY ("company_id", "physical_stock_count_line_id") REFERENCES "physical_stock_count_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_recorded_by_membership_fkey" FOREIGN KEY ("company_id", "recorded_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "conservation_adjustments" ADD CONSTRAINT "conservation_adjustments_company_id_approved_by_membership_fkey" FOREIGN KEY ("company_id", "approved_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_processing_operatio_fkey" FOREIGN KEY ("company_id", "processing_operation_id") REFERENCES "processing_operations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_processing_output_i_fkey" FOREIGN KEY ("company_id", "processing_output_id") REFERENCES "processing_outputs"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "iud_structural_element_type_fkey" FOREIGN KEY ("company_id", "structural_element_type_id") REFERENCES "structural_element_types"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "iud_structural_element_instance_fkey" FOREIGN KEY ("company_id", "structural_element_instance_id") REFERENCES "structural_element_instances"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_location_node_id_fkey" FOREIGN KEY ("company_id", "location_node_id") REFERENCES "location_nodes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_reinforcement_purpo_fkey" FOREIGN KEY ("company_id", "reinforcement_purpose_id") REFERENCES "reinforcement_purposes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_bbs_line_id_fkey" FOREIGN KEY ("company_id", "bbs_line_id") REFERENCES "bbs_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_declared_by_members_fkey" FOREIGN KEY ("company_id", "declared_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "intended_usage_declarations" ADD CONSTRAINT "intended_usage_declarations_company_id_supersedes_id_fkey" FOREIGN KEY ("company_id", "supersedes_id") REFERENCES "intended_usage_declarations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reclassification_events" ADD CONSTRAINT "reclassification_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reclassification_events" ADD CONSTRAINT "reclassification_events_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reclassification_events" ADD CONSTRAINT "reclassification_events_company_id_recorded_by_membership__fkey" FOREIGN KEY ("company_id", "recorded_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "reclassification_events" ADD CONSTRAINT "reclassification_events_company_id_approved_by_membership__fkey" FOREIGN KEY ("company_id", "approved_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_schedules" ADD CONSTRAINT "bbs_schedules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_schedules" ADD CONSTRAINT "bbs_schedules_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_schedules" ADD CONSTRAINT "bbs_schedules_company_id_prepared_by_membership_id_fkey" FOREIGN KEY ("company_id", "prepared_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_schedules" ADD CONSTRAINT "bbs_schedules_company_id_approved_by_membership_id_fkey" FOREIGN KEY ("company_id", "approved_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_bbs_schedule_id_fkey" FOREIGN KEY ("company_id", "bbs_schedule_id") REFERENCES "bbs_schedules"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_structural_element_type_id_fkey" FOREIGN KEY ("company_id", "structural_element_type_id") REFERENCES "structural_element_types"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_structural_element_instance_id_fkey" FOREIGN KEY ("company_id", "structural_element_instance_id") REFERENCES "structural_element_instances"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_location_node_id_fkey" FOREIGN KEY ("company_id", "location_node_id") REFERENCES "location_nodes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_reinforcement_purpose_id_fkey" FOREIGN KEY ("company_id", "reinforcement_purpose_id") REFERENCES "reinforcement_purposes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "bbs_lines" ADD CONSTRAINT "bbs_lines_company_id_shape_code_id_fkey" FOREIGN KEY ("company_id", "shape_code_id") REFERENCES "shape_codes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_counts" ADD CONSTRAINT "physical_stock_counts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_counts" ADD CONSTRAINT "physical_stock_counts_company_id_storage_location_id_fkey" FOREIGN KEY ("company_id", "storage_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_counts" ADD CONSTRAINT "physical_stock_counts_company_id_counted_by_membership_id_fkey" FOREIGN KEY ("company_id", "counted_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_counts" ADD CONSTRAINT "physical_stock_counts_company_id_verified_by_membership_id_fkey" FOREIGN KEY ("company_id", "verified_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_count_lines" ADD CONSTRAINT "physical_stock_count_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_count_lines" ADD CONSTRAINT "physical_stock_count_lines_company_id_physical_stock_count_fkey" FOREIGN KEY ("company_id", "physical_stock_count_id") REFERENCES "physical_stock_counts"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "physical_stock_count_lines" ADD CONSTRAINT "physical_stock_count_lines_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfers" ADD CONSTRAINT "material_transfers_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfers" ADD CONSTRAINT "material_transfers_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfers" ADD CONSTRAINT "material_transfers_company_id_from_location_id_fkey" FOREIGN KEY ("company_id", "from_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfers" ADD CONSTRAINT "material_transfers_company_id_to_location_id_fkey" FOREIGN KEY ("company_id", "to_location_id") REFERENCES "storage_locations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfers" ADD CONSTRAINT "material_transfers_company_id_dispatched_by_membership_id_fkey" FOREIGN KEY ("company_id", "dispatched_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_lines" ADD CONSTRAINT "material_transfer_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_lines" ADD CONSTRAINT "material_transfer_lines_company_id_material_transfer_id_fkey" FOREIGN KEY ("company_id", "material_transfer_id") REFERENCES "material_transfers"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_lines" ADD CONSTRAINT "material_transfer_lines_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_lines" ADD CONSTRAINT "material_transfer_lines_company_id_split_from_material_uni_fkey" FOREIGN KEY ("company_id", "split_from_material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipts" ADD CONSTRAINT "material_transfer_receipts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipts" ADD CONSTRAINT "material_transfer_receipts_company_id_material_transfer_id_fkey" FOREIGN KEY ("company_id", "material_transfer_id") REFERENCES "material_transfers"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipts" ADD CONSTRAINT "material_transfer_receipts_company_id_received_by_membersh_fkey" FOREIGN KEY ("company_id", "received_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipt_lines" ADD CONSTRAINT "material_transfer_receipt_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipt_lines" ADD CONSTRAINT "mtrl_receipt_fkey" FOREIGN KEY ("company_id", "material_transfer_receipt_id") REFERENCES "material_transfer_receipts"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipt_lines" ADD CONSTRAINT "mtrl_transfer_line_fkey" FOREIGN KEY ("company_id", "material_transfer_line_id") REFERENCES "material_transfer_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "material_transfer_receipt_lines" ADD CONSTRAINT "material_transfer_receipt_lines_company_id_resulting_mater_fkey" FOREIGN KEY ("company_id", "resulting_material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_project_id_fkey" FOREIGN KEY ("company_id", "project_id") REFERENCES "projects"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_structural_element_instance_id_fkey" FOREIGN KEY ("company_id", "structural_element_instance_id") REFERENCES "structural_element_instances"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_reinforcement_purpose_id_fkey" FOREIGN KEY ("company_id", "reinforcement_purpose_id") REFERENCES "reinforcement_purposes"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_intended_usage_declaration_id_fkey" FOREIGN KEY ("company_id", "intended_usage_declaration_id") REFERENCES "intended_usage_declarations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_bbs_line_id_fkey" FOREIGN KEY ("company_id", "bbs_line_id") REFERENCES "bbs_lines"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_installed_by_membership_id_fkey" FOREIGN KEY ("company_id", "installed_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_verified_by_membership_id_fkey" FOREIGN KEY ("company_id", "verified_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installations" ADD CONSTRAINT "installations_company_id_supersedes_id_fkey" FOREIGN KEY ("company_id", "supersedes_id") REFERENCES "installations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installation_lines" ADD CONSTRAINT "installation_lines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installation_lines" ADD CONSTRAINT "installation_lines_company_id_installation_id_fkey" FOREIGN KEY ("company_id", "installation_id") REFERENCES "installations"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "installation_lines" ADD CONSTRAINT "installation_lines_company_id_material_unit_id_fkey" FOREIGN KEY ("company_id", "material_unit_id") REFERENCES "material_units"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_uploaded_by_membership_id_fkey" FOREIGN KEY ("company_id", "uploaded_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_changed_by_membership_id_fkey" FOREIGN KEY ("company_id", "changed_by_membership_id") REFERENCES "company_memberships"("company_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

