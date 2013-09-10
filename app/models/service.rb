require 'capybara'
require 'capybara/poltergeist'
require 'thread'

class Service < ActiveRecord::Base

	belongs_to :dashboard

	validates_presence_of :name
	validates_presence_of :host

	# REFACTOR Nasty that this is a singleton, but it leaks a phantomjs process on #visit :(
	# https://github.com/jonleighton/poltergeist/issues/348
	BROWSER = Capybara::Session.new(:poltergeist)
	BROWSER_LOCK = Mutex.new

	PHOTO_OPTS  = {
	  :x => 0,          # top left position
	  :y => 0,
	  :w => 1280,       # bottom right position
	  :h => 1024,
	
	  :wait => 0.5,     # if selector is nil, wait 1 seconds before taking the screenshot
	  :selector => nil  # wait until the selector matches to take the screenshot
	}

	def expire_check
		self.checked_at = nil
		self.http_screenshot = nil
		self.save
	end

	def check_if_older_than(date)
		last = self.checked_at
		if last.nil? || last < date
			puts "Checking service #{self.name}."
			check
		else
			puts "Skipping service check for #{self.name}."
		end
	end

	def check
		self.http_screenshot = nil # Clear the old screenshots, regardless.

		if ping
			p = Net::Ping::External.new(self.host)
			if p.ping
				self.ping_last = (p.duration * 1000).to_i
			else
				self.ping_last = -1
			end
		end
		host = self.host
		path = self.http_path
		path = '/index.html' if(path.nil? || path == '')
		if self.http			
			uri = URI("http://#{self.host}#{self.http_path}")
			good = false
			begin
				Net::HTTP.start(uri.host, uri.port) do |http|
					request = Net::HTTP::Get.new uri
					response = http.request request # Net::HTTPResponse object
					code = response.code.to_i
					# puts "CODE: #{code}"
					self.http_path_last = (code >= 200 && code < 400)
				end
			rescue
				# Possibly a DNS failure or something.
				self.http_path_last = false
			end

			if http_xquery
				# TODO
			end
		end

		if self.https
			uri = URI("http://#{self.host}#{self.http_path}")
			good = false
			begin
				Net::HTTP.start(uri.host, uri.port) do |https|
					request = Net::HTTP::Get.new uri
					response = https.request request # Net::HTTPResponse object
					code = response.code.to_i
					# puts "CODE S: #{code}"
					self.https_path_last = (code >= 200 && code < 400)
				end
			rescue
				# Possibly a DNS failure or something.
				self.https_path_last = false
			end
		end

		if http_preview && (http || https)
			uri = URI("http://#{self.host}#{self.http_path}")
			if https
				uri = URI("https://#{self.host}#{self.http_path}")
			end
			begin
				BROWSER_LOCK.synchronize do
					puts "Visiting #{uri}"
					BROWSER.reset!
					BROWSER.visit uri.to_s
					sleep 0.100 # Brief artificial delay for rendering. :(
		
					tmp = Tempfile.new(['screenshot', '.png'])
					# puts tmp.path
					begin
						BROWSER.driver.render tmp.path,
						  :width  => PHOTO_OPTS[:w] + PHOTO_OPTS[:x],
						  :height => PHOTO_OPTS[:h] + PHOTO_OPTS[:y]
						self.http_screenshot = IO.read tmp.path
					ensure
						tmp.close # Close and delete the temporary file.
						tmp.unlink
					end
				end
			rescue
				# The visit will throw an exception if it times out.
			end
			
		end

		self.checked_at = Time.now
		self.save!
	end
	
	def known_good(since)
		known = false
		if !self.checked_at.nil? && (since.nil? || self.checked_at >= since)
			ping_good = (!self.ping || (!self.ping_last.nil? && self.ping_last >= 0 && self.ping_last <= self.ping_threshold))
			http_good = (!self.http || self.http_path_last)
			https_good = (!self.https || self.https_path_last)
			# TODO xquery_good = (self.http_xquery.nil? || self.http_xquery == '' || (self.http_xquery && TODO))
			if ping_good && http_good && https_good
				known = true
			end
		end
		known
	end
	
	def known_bad(since)
		known = false
		if (self.checked_at && since.nil?) || (!since.nil? && self.checked_at >= since)
			ping_bad = self.ping && !self.ping_last.nil? && (self.ping_last > self.ping_threshold || self.ping_last < 0)
			http_bad = self.http && !self.http_path_last
			https_bad = self.https && !self.https_path_last
			# xquery_bad = self.http_xquery && TODO
			if ping_bad || http_bad || https_bad
				known = true
			end
		end
		known
	end
	
end
