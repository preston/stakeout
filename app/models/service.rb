class Service < ActiveRecord::Base

	belongs_to :dashboard

	validates_presence_of :name
	validates_presence_of :host

	attr_accessible	:dashboard, :dashboard_id, :name, :host, :ping, :ping_threshold, :ping_last, :http, :https, :http_path, :http_path_last, :http_xquery, :http_xquery_last, :http_preview
	

	def check
		if ping
		end
		if http
			if http_xquery
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
