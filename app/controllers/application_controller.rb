class ApplicationController < ActionController::Base

	protect_from_forgery

	def ensure_active_dashboard_is_set
		id = session[:active_dashboard_id]
		if id
			begin
				@active_dashboard = Dashboard.find(id)
			rescue
			end
			if !@active_dashboard
				set_an_active_dashboard
			end
		else
			set_an_active_dashboard
		end
	end

	def set_an_active_dashboard
		d = Dashboard.first
		if !d
			d = Dashboard.new
			d.name = "Default"
			d.save!
		end
	 	set_as_active_dashboard(d)
	end
	
	def set_as_active_dashboard(d)
		@active_dashboard = d
		set_session_active_dashboard_id(d.id)
	end
	
	def set_session_active_dashboard_id(id)
		session[:active_dashboard_id] = id
	end
	
	def active_dashboard_id
		session[:active_dashboard_id]
	end

end
