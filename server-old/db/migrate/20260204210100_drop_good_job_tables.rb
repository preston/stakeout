# frozen_string_literal: true

# Safe for incremental rollout: uses if_exists so it no-ops when Good Job was never
# installed (e.g. fresh DB). The create_good_jobs migration was removed; existing
# production will have already run it, so this drop runs once and removes the tables.
class DropGoodJobTables < ActiveRecord::Migration[8.1]
  def up
    # Drop in order to respect FKs: executions -> jobs/processes; jobs -> processes, batches.
    drop_table :good_job_executions, if_exists: true
    drop_table :good_jobs, if_exists: true
    drop_table :good_job_batches, if_exists: true
    drop_table :good_job_processes, if_exists: true
    drop_table :good_job_settings, if_exists: true
  end

  def down
    # Good Job tables are no longer recreated; use Good Job migrations if reverting.
    raise ActiveRecord::IrreversibleMigration
  end
end
