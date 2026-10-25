CREATE TABLE "document_profile_import" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"file_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"rows" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "document_profile_import" ADD CONSTRAINT "document_profile_import_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_profile_import" ADD CONSTRAINT "document_profile_import_file_id_file_index_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file_index"("id") ON DELETE no action ON UPDATE no action;