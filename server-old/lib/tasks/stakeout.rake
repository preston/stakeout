namespace :stakeout do
  def update_older_than(t)
    list = Service.where('checked_at IS NULL OR checked_at <= ?', t).all
    Rails.logger.info "Updating #{list.length} services..."
    list.each do |s|
      Rails.logger.info "\t#{s.name}"
      s.check
    end
  end

  desc 'Serially checks all known services not updated within the last minute.'
  task check_1_minute: :environment do
    update_older_than(1.minute.ago)
  end

  desc 'Serially checks all known services not updated within the 5 minutes.'
  task check_5_minutes: :environment do
    update_older_than(5.minutes.ago)
  end

  namespace :verify do
    desc 'Verify Chrome (Browserless) at STAKEOUT_SERVER_CHROME_URL can be reached and returns a screenshot.'
    task chrome: :environment do
      ok, message = Service.verify_chrome_connection
      puts "Chrome verification: #{message}"
      exit(ok ? 0 : 1)
    end

    desc 'Verify Solid Queue: DB connectivity and job table counts.'
    task solid_queue: :environment do
      puts "Solid Queue verification"
      puts "  queue_adapter: #{Rails.application.config.active_job.queue_adapter}"

      ActiveRecord::Base.connection.execute("SELECT 1")
      puts "  DB connection: OK"

      # Count jobs from solid_queue_jobs (same DB)
      conn = ActiveRecord::Base.connection
      unfinished = conn.select_value("SELECT COUNT(*) FROM solid_queue_jobs WHERE finished_at IS NULL")
      ready = conn.select_value(<<~SQL)
        SELECT COUNT(*) FROM solid_queue_jobs j
        WHERE j.finished_at IS NULL AND j.scheduled_at <= NOW()
        AND NOT EXISTS (SELECT 1 FROM solid_queue_claimed_executions c WHERE c.job_id = j.id)
      SQL
      recent = conn.select_value(ActiveRecord::Base.sanitize_sql_array([ "SELECT COUNT(*) FROM solid_queue_jobs WHERE finished_at >= ?", 1.hour.ago ]))
      puts "  Unfinished: #{unfinished}, Ready (unclaimed): #{ready}, Finished (last hour): #{recent}"
      puts "Done."
    end
  end

  namespace :debug do
    desc 'Print DB connections and Solid Queue job state (run while worker is hung).'
    task worker: :environment do
      conn = ActiveRecord::Base.connection
      puts "=== pg_stat_activity (#{Time.current}) ==="
      rows = conn.select_all(<<~SQL).to_a
        SELECT pid, state, wait_event_type, wait_event,
               now() - state_change AS state_duration,
               left(application_name, 24) AS app,
               left(query, 100) AS query
        FROM pg_stat_activity
        WHERE datname = current_database()
        ORDER BY state_change
      SQL
      rows.each do |r|
        dur = r["state_duration"].is_a?(String) ? r["state_duration"] : r["state_duration"]&.iso8601
        puts "  pid=#{r['pid']} state=#{r['state']} wait=#{r['wait_event_type']}/#{r['wait_event']} duration=#{dur} app=#{r['app']}"
        puts "    query: #{r['query']&.strip&.tr("\n", ' ')}"
      end
      puts "\n=== solid_queue_jobs ==="
      unfinished = conn.select_value("SELECT COUNT(*) FROM solid_queue_jobs WHERE finished_at IS NULL")
      claimed = conn.select_value("SELECT COUNT(*) FROM solid_queue_claimed_executions")
      puts "  Unfinished: #{unfinished}, Claimed (in progress): #{claimed}"
      puts "\n=== hint ==="
      puts "  idle + ClientRead for a long time => worker stuck in app code (e.g. HTTP), not in DB."
      puts "  state=active + wait_event_type=Lock => worker waiting on a DB lock."
      puts "Done."
    end
  end
end
