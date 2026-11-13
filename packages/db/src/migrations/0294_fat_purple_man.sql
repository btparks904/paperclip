ALTER TABLE "agent_instruction_working_copies" ADD COLUMN IF NOT EXISTS "instruction_bundle_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "instruction_bundle_id" uuid;
