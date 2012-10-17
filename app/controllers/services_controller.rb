class ServicesController < ApplicationController

  # GET
  def index
		d = Dashboard.find(params[:dashboard_id])
		set_as_active_dashboard(d)
    @services = Service.where(dashboard_id: params[:dashboard_id])

    respond_to do |format|
      format.html { render layout: false }
      format.json { render json: @services }
    end
  end

  # GET /1
  def show
    @service = Service.find(params[:id])

    respond_to do |format|
      format.html # show.html.erb
      format.json { render json: @service }
    end
  end

  # GET /new
  def new
    @service = Service.new

    respond_to do |format|
      format.html { render layout: false } # new.html.erb
      format.json { render json: @service }
    end
  end

  # GET /1/edit
  def edit
    @service = Service.find(params[:id])
  end

  # POST
  def create
    @service = Service.new(params[:service])

    respond_to do |format|
      if @service.save
        # format.html { redirect_to dashboards_path, notice: 'Service was successfully created.' }
				format.html { render partial: 'services/service', layout: false, locals: {service: @service} }
        format.json { render json: @service, status: :created, location: @service }
      else
        format.html { render action: "new" }
        format.json { render json: @service.errors, status: :unprocessable_entity }
      end
    end
  end

  # PUT
  def update
    @service = Service.find(params[:id])

    respond_to do |format|
      if @service.update_attributes(params[:service])
        format.html { redirect_to @service, notice: 'Service was successfully updated.' }
        format.json { head :no_content }
      else
        format.html { render action: "edit" }
        format.json { render json: @service.errors, status: :unprocessable_entity }
      end
    end
  end

  # DELETE
  def destroy
    @service = Service.find(params[:id])
    @service.destroy

    respond_to do |format|
      # format.html { redirect_to dashboards_path }
      format.json { head :no_content }
    end
  end
end
