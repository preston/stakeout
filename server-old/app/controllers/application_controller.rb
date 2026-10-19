# frozen_string_literal: true

class ApplicationController < ActionController::Base
  # We *only* support JSON endpoints.
  before_action :ensure_json_request, except: [:cors_preflight_check]

  def ensure_json_request
    return if params[:format] == 'json' || request.headers['Accept'] =~ %r{application/json}

    render json: { message: "This service only responds to JSON requests. Please set your 'Accept' header to 'application/json'." },
           status: 406
  end

  def http_authenticate
    u = authenticate_with_http_basic do |username, password|
      # puts "username: #{ENV['STAKEOUT_SERVER_USERNAME']}, password: #{ENV['STAKEOUT_SERVER_PASSWORD']}"
      username == ENV['STAKEOUT_SERVER_USERNAME'] && password == ENV['STAKEOUT_SERVER_PASSWORD']
    end
    return if u

    render json: { message: 'HTTP Basic: Access denied.' }, status: 401
  end

  #   def ensure_active_dashboard_is_set
  #     id = session[:active_dashboard_id]
  #     if id
  #       begin
  #         @active_dashboard = Dashboard.find(id)
  #       rescue StandardError
  #       end
  #       set_an_active_dashboard unless @active_dashboard
  #     else
  #       set_an_active_dashboard
  #     end
  #   end

  #   def set_an_active_dashboard
  #     d = Dashboard.first
  #     unless d
  #       d = Dashboard.new
  #       d.name = 'Default'
  #       d.save!
  #     end
  #     set_as_active_dashboard(d)
  #   end

  #   def set_as_active_dashboard(d)
  #     @active_dashboard = d
  #     set_session_active_dashboard_id(d.id)
  #   end

  #   def set_session_active_dashboard_id(id)
  #     session[:active_dashboard_id] = id
  #   end

  #   def active_dashboard_id
  #     session[:active_dashboard_id]
  #   end
end
