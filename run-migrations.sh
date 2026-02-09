#!/bin/bash
# Helper script to list all migrations in order
# Copy each migration content and run in Supabase SQL Editor

echo "Run these migrations in Supabase SQL Editor (in order):"
echo ""
echo "1. supabase/migrations/20250130000000_create_workspaces_and_files.sql"
echo "2. supabase/migrations/20250130100000_add_workspace_github_metadata.sql"
echo "3. supabase/migrations/20250201000000_create_provider_keys.sql"
echo "4. supabase/migrations/20250202000000_create_indexing_tables.sql"
echo "5. supabase/migrations/20250205000000_github_oauth_and_workspace_sync.sql"
echo "6. supabase/migrations/20250205100000_add_safe_edit_mode_to_workspaces.sql"
echo "7. supabase/migrations/20250206000000_github_oauth_config.sql"
echo "8. supabase/migrations/20250207000000_user_workspace_state.sql"
echo "9. supabase/migrations/20250208000000_create_sandbox_tables.sql"
echo "10. supabase/migrations/20250209000000_add_embeddings_support.sql"
echo "11. supabase/migrations/20250209000001_add_vector_search_function.sql"
echo "12. supabase/migrations/20250210000000_add_chat_memory.sql"
echo "13. supabase/migrations/20250210000001_add_merkle_tree.sql"
echo ""
echo "Then run: CREATE EXTENSION IF NOT EXISTS vector;"
