# Author: Preston Lee

class ServicesController < ApplicationController
  before_action :http_authenticate, except: %i[index show]
  before_action :set_dashboard # , only: %i[create show update destroy]
  before_action :set_service, only: %i[show update destroy]

  # GET /services
  # GET /services.json
  def index
    # @services = Service.paginate(page: params[:page], per_page: params[:per_page])
    @services = Service.where(dashboard: @dashboard)
    sort = %w[name updated_at created_at].include?(params[:sort]) ? params[:sort] : :name
    order = params[:order] == 'desc' ? :desc : :asc
    @services = @services.order(sort => order)
    @services = @services.search_by_name(params[:text]) if params[:text]

    @with_screenshots = params[:screenshots] == 'true'

    # period = 0
    # period = params[:period].to_i unless params[:period].nil?
    # @dashboard = Dashboard.find(params[:dashboard_id])
    # @services = @dashboard.services
    # since = Time.now - period
    # @services.each do |s|
    #   s.check_if_older_than(since)
    # end
    # render layout: false

    @dashboard.services.each do |s|
      if s.check_is_needed
        job = CheckServiceJob.perform_later(s.id)
        Rails.logger.debug "Enqueued job with key: #{job}"
      else
        Rails.logger.debug "Service #{s.name} doesn't need to be checked. Skipping."
      end
    end
  end

  # def check
  #   period = params[:client_period].to_i
  #   @since = period.minutes.ago
  #   d = Dashboard.find(session[:active_dashboard_id])
  #   d.services.each do |s|
  #     s.check_if_needed
  #   end
  #   rendor json: 'services/index'
  # end

  # GET /services/1
  # GET /services/1.json
  def show
  end

  # POST
  def create
    @service = Service.new(service_params)
    @service.dashboard = @dashboard
    # @service.validate

    if @service.save
      # puts @service.errors.to_json
      render :show, json: @service, status: :created, location: [@service.dashboard, @service]
    else
      Rails.logger.warn @service.errors.to_json
      # render json: @service.errors, status: :unprocessable_entity
    end
  end

  # PUT
  def update
    @service.dashboard = @dashboard
    if @service.update(service_params)
      @service.expire_check
      render :show, json: @service, location: [@service.dashboard, @service]
    else
      render :show, json: @service.errors, status: :unprocessable_entity
    end
  end

  # DELETE
  def destroy
    @service.destroy
    head :no_content
  end

  private

  def set_dashboard
    # puts "DASH: " + params[:dashboard_id]
    @dashboard = Dashboard.find(params[:dashboard_id])
    # puts @dashboard.name
  end

  # Use callbacks to share common setup or constraints between actions.
  def set_service
    @service = Service.find(params[:id])
  end

  # Never trust parameters from the scary internet, only allow the white list through.
  def service_params
    params.require(:service).permit(:name, :dashboard_id, :host, :port,
                                    :http, :https,
                                    :http_preview, :http_path, :http_xquery)
  end
end
