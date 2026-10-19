require 'net/http'

class Service < ApplicationRecord
  include PgSearch::Model
  # pg_search_scope :search_by_name_or_description, against: %i[name description], using: {
  pg_search_scope :search_by_name, against: %i[name], using: {
    #    trigram: {},
    tsearch: { prefix: true } # Partial words
  }

  belongs_to :dashboard, touch: true
  validates_presence_of :dashboard

  # validates_presence_of :dashboard
  validates_presence_of :name
  validates_presence_of :host

  def expire_check
    self.checked_at = nil
    self.http_screenshot = nil
    save
  end

  def check_if_older_than(date)
    last = checked_at
    if last.nil? || last < date
      Rails.logger.debug "Checking service #{name}."
      check
    else
      Rails.logger.debug "Skipping service check for #{name}."
    end
  end

  def check_is_needed
    checked_at.nil? || checked_at < 1.minute.ago
  end

  #   def check_if_needed
  #     if !checked_is_needed
  # puts "Service #{self.name} doesn't need to be checked. Skipping."
  #     else
  #     CheckServiceJob.perform_later(self)
  #   end
  # end

  # Timeouts for service checks so the worker never blocks on slow/unresponsive targets.
  CHECK_OPEN_TIMEOUT_SEC = 5
  CHECK_READ_TIMEOUT_SEC = 10

  def check
    Rails.logger.info "[CHECK_DEBUG] check start id=#{id} name=#{name} http=#{http} https=#{https} http_preview=#{http_preview}"
    unless check_is_needed
      Rails.logger.info '[CHECK_DEBUG] check skip (check_is_needed false)'
      return
    end

    self.http_screenshot = nil # Clear the old screenshots, regardless.

    if http
      port = 80 if self.port == 0
      uri = URI("http://#{self.host}:#{port}#{http_path}")
      Rails.logger.info "[CHECK_DEBUG] http start uri=#{uri}"
      begin
        Net::HTTP.start(uri.host, uri.port, open_timeout: CHECK_OPEN_TIMEOUT_SEC,
                                            read_timeout: CHECK_READ_TIMEOUT_SEC) do |http|
          request = Net::HTTP::Get.new uri
          response = http.request request # Net::HTTPResponse object
          code = response.code.to_i
          # puts "CODE: #{code}"
          self.http_path_last = (code >= 200 && code < 400)
        end
      rescue StandardError
        self.http_path_last = false
      end
      Rails.logger.info "[CHECK_DEBUG] http done http_path_last=#{http_path_last}"

      if http_xquery
        # TODO
      end
    end

    if https
      port = 443 if self.port == 0
      uri = URI("https://#{self.host}:#{port}#{http_path}")
      Rails.logger.info "[CHECK_DEBUG] https start uri=#{uri}"
      begin
        Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: CHECK_OPEN_TIMEOUT_SEC,
                                            read_timeout: CHECK_READ_TIMEOUT_SEC) do |https|
          request = Net::HTTP::Get.new uri
          response = https.request request # Net::HTTPResponse object
          code = response.code.to_i
          # puts "CODE HTTPS: #{code}"
          self.https_path_last = (code >= 200 && code < 400)
        end
      rescue StandardError
        self.https_path_last = false
      end
      Rails.logger.info "[CHECK_DEBUG] https done https_path_last=#{https_path_last}"
    end

    if http_preview && (http || https)
      uri = URI("http://#{self.host}:#{self.port == 0 ? 80 : self.port}#{http_path}")
      uri = URI("https://#{self.host}:#{self.port == 0 ? 443 : self.port}#{http_path}") if https
      Rails.logger.info "[CHECK_DEBUG] screenshot start uri=#{uri}"
      self.http_screenshot = nil

      capture_screenshot_via_browserless(uri)
      Rails.logger.info '[CHECK_DEBUG] screenshot done'
    end
    Rails.logger.info '[CHECK_DEBUG] save! start'
    self.checked_at = Time.now
    save!
    Rails.logger.info '[CHECK_DEBUG] save! done'
  end

  # Browserless REST screenshot API (no Puppeteer). STAKEOUT_SERVER_CHROME_URL can be
  # ws://host:port (we use http://) or already http(s)://. Optional STAKEOUT_SERVER_CHROME_TOKEN.
  SCREENSHOT_TIMEOUT_SEC = 15

  # PNG magic bytes; used to verify Browserless returned an image, not an error body.
  PNG_MAGIC = "\x89PNG\r\n\x1A\n".b

  SCREENSHOT_VIEWPORT = { width: 1280, height: 1280 }.freeze
  SCREENSHOT_GOTO_OPTIONS = { waitUntil: 'networkidle2', timeout: 5000 }.freeze

  def capture_screenshot_via_browserless(uri)
    Rails.logger.info "[CHECK_DEBUG] capture_screenshot_via_browserless start uri=#{uri}"
    rest_base = browserless_rest_base_from_env
    return unless rest_base

    self.http_screenshot = fetch_screenshot_via_http(
      browserless_screenshot_url(rest_base),
      screenshot_request_body(uri.to_s)
    )
    Rails.logger.info '[CHECK_DEBUG] capture_screenshot_via_browserless done'
  end

  def fetch_screenshot_via_http(screenshot_url, body)
    target = URI(screenshot_url)
    Rails.logger.info "[CHECK_DEBUG] fetch_screenshot_via_http start host=#{target.host} port=#{target.port}"
    result = Net::HTTP.start(target.host, target.port, use_ssl: target.scheme == 'https', open_timeout: 5,
                                                       read_timeout: SCREENSHOT_TIMEOUT_SEC) do |http|
      request = Net::HTTP::Post.new(target.request_uri)
      request['Content-Type'] = 'application/json'
      request['Cache-Control'] = 'no-cache'
      request.body = body
      Rails.logger.info '[CHECK_DEBUG] fetch_screenshot POST request sent, waiting for response...'
      response = http.request(request)
      Rails.logger.info "[CHECK_DEBUG] fetch_screenshot response received code=#{response.code}"
      if response.is_a?(Net::HTTPSuccess) && response.body.present?
        data = response.body.dup.force_encoding(Encoding::BINARY)
        if data.start_with?(PNG_MAGIC)
          data
        else
          Rails.logger.warn "Browserless screenshot returned non-PNG body (Content-Type: #{response['Content-Type']})"
          nil
        end
      else
        Rails.logger.warn "Browserless screenshot failed: HTTP #{response.code}" unless response.is_a?(Net::HTTPSuccess)
        nil
      end
    end
    Rails.logger.info '[CHECK_DEBUG] fetch_screenshot_via_http done'
    result
  rescue Errno::ECONNREFUSED, Errno::EHOSTUNREACH, SocketError => e
    Rails.logger.warn "Browserless Chrome unreachable at #{target&.host}:#{target&.port} - #{e.message}"
    nil
  rescue Timeout::Error, Net::OpenTimeout, Net::ReadTimeout => e
    Rails.logger.warn "Browserless screenshot timeout - #{e.message}"
    nil
  rescue StandardError => e
    Rails.logger.warn "Browserless screenshot error: #{e.class} - #{e.message}"
    nil
  end

  def browserless_rest_base_url(chrome_url)
    return nil if chrome_url.blank?

    case chrome_url
    when %r{\Awss://(.*)\z}i
      "https://#{Regexp.last_match(1)}"
    when %r{\Aws://(.*)\z}i
      "http://#{Regexp.last_match(1)}"
    when %r{\Ahttps?://}
      chrome_url
    else
      "http://#{chrome_url}"
    end
  end

  # Returns REST base URL from STAKEOUT_SERVER_CHROME_URL, or nil if blank/invalid.
  def browserless_rest_base_from_env
    chrome_url = ENV['STAKEOUT_SERVER_CHROME_URL'].to_s.strip
    if chrome_url.blank?
      self.http_screenshot = nil
      Rails.logger.info '[CHECK_DEBUG] capture_screenshot skip (CHROME_URL blank)'
      return nil
    end
    rest_base = browserless_rest_base_url(chrome_url)
    unless rest_base
      self.http_screenshot = nil
      Rails.logger.info '[CHECK_DEBUG] capture_screenshot skip (rest_base nil)'
      return nil
    end
    rest_base
  end

  def browserless_screenshot_url(rest_base)
    url = "#{rest_base}/screenshot"
    url += "?token=#{ERB::Util.url_encode(ENV['STAKEOUT_SERVER_CHROME_TOKEN'])}" if ENV['STAKEOUT_SERVER_CHROME_TOKEN'].present?
    url
  end

  def screenshot_request_body(url)
    {
      url: url,
      viewport: SCREENSHOT_VIEWPORT,
      options: { type: 'png' },
      gotoOptions: SCREENSHOT_GOTO_OPTIONS
    }.to_json
  end

  # Verifies connectivity to Browserless at STAKEOUT_SERVER_CHROME_URL by requesting a
  # minimal screenshot. Returns [true, message] on success, [false, message] on failure.
  def self.verify_chrome_connection
    instance = new
    rest_base = instance.browserless_rest_base_for_verify
    return rest_base unless rest_base.is_a?(String)

    result = instance.fetch_screenshot_via_http(
      instance.browserless_screenshot_url(rest_base),
      instance.screenshot_request_body('about:blank')
    )
    if result.present? && result.start_with?(PNG_MAGIC)
      [true, "Chrome at #{rest_base} returned PNG (OK)"]
    else
      [false, result.present? ? 'Chrome returned non-PNG body' : "Chrome unreachable or returned error at #{rest_base}"]
    end
  end

  # Returns rest_base string on success, or [false, message] for verify_chrome_connection.
  def browserless_rest_base_for_verify
    chrome_url = ENV['STAKEOUT_SERVER_CHROME_URL'].to_s.strip
    return [false, 'STAKEOUT_SERVER_CHROME_URL is blank'] if chrome_url.blank?

    rest_base = browserless_rest_base_url(chrome_url)
    return [false, "Could not build REST base URL from #{chrome_url.inspect}"] unless rest_base

    rest_base
  end

  def known_good(since)
    known = false
    if !checked_at.nil? && (since.nil? || checked_at >= since)
      http_good = !http || http_path_last
      https_good = !https || https_path_last
      # TODO: xquery_good = (self.http_xquery.nil? || self.http_xquery == '' || (self.http_xquery && TODO))
      known = true if http_good && https_good
    end
    known
  end

  def known_bad(since)
    known = false
    if (checked_at && since.nil?) || (!since.nil? && checked_at >= since)
      http_bad = http && !http_path_last
      https_bad = https && !https_path_last
      # xquery_bad = self.http_xquery && TODO
      known = true if http_bad || https_bad
    end
    known
  end
end
