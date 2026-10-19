# frozen_string_literal: true

# Asynchronous job for running availability checks on a given service.
# Service#check is idempotent (check_is_needed); duplicate enqueues are harmless.
class CheckServiceJob < ApplicationJob
  queue_as :service_checks_with_chrome

  # Hard limit so a stuck HTTP/screenshot cannot hang the worker indefinitely.
  PERFORM_TIMEOUT_SEC = 60

  around_perform do |_job, block|
    Timeout.timeout(PERFORM_TIMEOUT_SEC, &block)
  end

  def perform(service_id)
    service = Service.find(service_id)
    service.check
  end
  
end
