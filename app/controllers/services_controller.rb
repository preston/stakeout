class ServicesController < ApplicationController

  before_action :set_service, only: [:show, :edit, :update, :destroy]


  # GET /services
  # GET /services.json
  def index
    period = 0
    if !params[:period].nil?
      period = params[:period].to_i
    end
    @dashboard = Dashboard.find(params[:dashboard_id])
    @services = @dashboard.services
    since = Time.now - period
    @services.each do |s|
      s.check_if_older_than(since)
    end
    render layout: false
  end

  # GET /services/1
  # GET /services/1.json
  def show
  end

  # GET /services/new
  def new
    @dashboard = Dashboard.find(params[:dashboard_id])
    @service = Service.new
    @service.dashboard = @dashboard
    render partial: 'services/new'
  end

  # GET /services/1/edit
  def edit
    render partial: 'services/edit'
  end

  # POST
  def create
    @service = Service.new(service_params)

    respond_to do |format|
      if @service.save
        # format.html { redirect_to dashboards_path, notice: 'Service was successfully created.' }
				format.html { render partial: 'services/service', layout: false, locals: {service: @service} }
        format.json { render json: @service, status: :created, location: @service }
      else
        format.html { render partial: "services/new", layout: false, status: :unprocessable_entity }
        format.json { render json: @service.errors, status: :unprocessable_entity }
      end
    end
  end

  # PUT
  def update
    respond_to do |format|
      if @service.update(service_params)
        @service.expire_check
        format.html { render partial: 'services/service', layout: false, locals: {service: @service} }
        format.json { head :no_content }
      else
        format.html { render partial: "services/edit", layout: false, status: :unprocessable_entity }
        format.json { render json: @service.errors, status: :unprocessable_entity }
      end
    end
  end

  # DELETE
  def destroy
    @service.destroy
    respond_to do |format|
      # format.html { redirect_to dashboards_path }
      format.json { head :no_content }
    end
  end

  private
    # Use callbacks to share common setup or constraints between actions.
    def set_service
      @service = Service.find(params[:id])
    end

    # Never trust parameters from the scary internet, only allow the white list through.
    def service_params
      params.require(:service).permit(:name, :dashboard_id, :host, :ping, :ping_threshold, :http, :https, :http_preview, :http_path, :http_xquery)

    end

end
