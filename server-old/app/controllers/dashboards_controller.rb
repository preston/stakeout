class DashboardsController < ApplicationController
  before_action :http_authenticate, except: %i[index show]
  before_action :set_dashboard, only: %i[show update destroy]

  # before_action :ensure_active_dashboard_is_set, only: [:index]

  # GET /dashboards
  # GET /dashboards.json
  def index
    sort = %w[name].include?(params[:sort]) ? params[:sort] : :name
    order = params[:order] == 'desc' ? :desc : :asc
    @dashboards = Dashboard.order(sort => order)
    @dashboards = @dashboards.search_by_name(params[:text]) if params[:text]
  end

  # GET /services/1
  # GET /services/1.json
  def show
    # @dashboard.services.each do |s|
    #   if s.check_is_needed
    #     job = CheckServiceJob.perform_later(s.id)
    #     Rails.logger.debug "Enqueued job with key: #{job}"
    #   else
    #     Rails.logger.debug "Service #{s.name} doesn't need to be checked. Skipping."
    #   end
    # end
    render :show
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

  # POST /dashboards
  # POST /dashboards.json
  def create
    @dashboard = Dashboard.new(dashboard_params)
    if @dashboard.save
      render json: @dashboard, status: :created, location: @dashboard
    else
      render json: @dashboard.errors, status: :unprocessable_entity
    end
  end

  def update
    if @dashboard.update(dashboard_params)
      render json: @dashboard
    else
      render json: @dashboard.errors, status: :unprocessable_entity
    end
  end

  # DELETE /dashboards/1
  # DELETE /dashboards/1.json
  def destroy
    @dashboard.destroy
    # set_an_active_dashboard
    render	json: @active_dashboard
  end

  private

  # Use callbacks to share common setup or constraints between actions.
  def set_dashboard
    @dashboard = Dashboard.find(params[:id])
  end

  # Never trust parameters from the scary internet, only allow the white list through.
  def dashboard_params
    params.require(:dashboard).permit(:name)
  end
end
