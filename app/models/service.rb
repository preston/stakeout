require 'capybara'
require 'capybara/poltergeist'

class Service < ActiveRecord::Base

	belongs_to :dashboard

	validates_presence_of :name
	validates_presence_of :host


	PHOTO_OPTS  = {
	  :x => 0,          # top left position
	  :y => 0,
	  :w => 1280,       # bottom right position
	  :h => 1024,
	
	  :wait => 0.5,     # if selector is nil, wait 1 seconds before taking the screenshot
	  :selector => nil  # wait until the selector matches to take the screenshot
	}

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
		if http			
			host = self.host
			path = self.http_path
			path = '/index.html' if(path.nil? || path == '')
			uri = URI("http://#{self.host}#{self.http_path}")
			good = false
			begin
				Net::HTTP.start(uri.host, uri.port) do |http|
					request = Net::HTTP::Get.new uri
					response = http.request request # Net::HTTPResponse object
					code = response.code
					self.http_path_last = (code >= 200 && code < 400)
				end
			rescue
				# Possibly a DNS failure or something.
				self.http_path_last = false
			end

			if http_preview
				browser = Capybara::Session.new :poltergeist
				browser.visit 'http://www.google.com'
				sleep 1
				
				# tmp = Tempfile.new(['photograph','.png'])
				tmp = Tempfile.new(['photograph', '.png'])
				puts tmp.path
				
				browser.driver.render tmp.path,
				  :width  => PHOTO_OPTS[:w] + PHOTO_OPTS[:x],
				  :height => PHOTO_OPTS[:h] + PHOTO_OPTS[:y]
				self.http_screenshot = IO.read tmp.path
				tmp.unlink # Delete the temporary file.
			end
			if http_xquery
				# TODO
			end
		end
		self.save!
	end
	
	def known_good(since)
		known = true
		if !checked_at || checked_at < since
			known = false
		elsif ping
			if ping_threshold > 0 && ping_last > ping_threshold
				known = false
			end
		elsif http
			if !http_path_last
				known = false
			end
		elsif http_xquery
			if !http_xquery_last
				known = false
			end
		end
		known
	end
	
	def known_bad(since)
		known = true
		if !checked_at || checked_at  < since
			known = false
		elsif ping
			if ping_threshold > 0 && ping_last <= ping_threshold
				known = false
			end
		elsif http
			if http_path_last
				known = false
			end
		elsif http_xquery
			if http_xquery_last
 				known= false
			end
		end
		known
	end
	
end
