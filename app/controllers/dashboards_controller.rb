class DashboardsController < ApplicationController
  # GET /dashboards
  # GET /dashboards.json
  def index
    @dashboards = Dashboard.all
		
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
	
    respond_to do |format|
      format.html # index.html.erb
      format.json { render json: @dashboards }
    end
  end

	def check
		period = params[:client_period].to_i
		@since = period.minutes.ago
		d = Dashboard.find(session[:active_dashboard_id])
		d.services.each do |s|
			s.check
		end
		respond_to do |format|
      format.html { render 'services/index', layout: false }
    end
	end
	
	def active
		d = Dashboard.find(params[:id])
		set_as_active_dashboard d
	    respond_to do |format|
	      format.html # show.html.erb
	      format.json { render json: d }
	    end
	end

  # GET /dashboards/1
  # GET /dashboards/1.json
  def show
    @dashboard = Dashboard.find(params[:id])

    respond_to do |format|
      format.html # show.html.erb
      format.json { render json: @dashboard }
    end
  end

  # GET /dashboards/new
  # GET /dashboards/new.json
  def new
    @dashboard = Dashboard.new

    respond_to do |format|
      format.html # new.html.erb
      format.json { render json: @dashboard }
    end
  end

  # GET /dashboards/1/edit
  def edit
    @dashboard = Dashboard.find(params[:id])
  end

  # POST /dashboards
  # POST /dashboards.json
  def create
    @dashboard = Dashboard.new(params[:dashboard])

    respond_to do |format|
      if @dashboard.save
				set_as_active_dashboard(@dashboard)
        format.html { redirect_to dashboards_path, notice: 'Dashboard was successfully created.' }
        format.json { render json: @dashboard, status: :created, location: @dashboard }
      else
        format.html { render action: "new" }
        format.json { render json: @dashboard.errors, status: :unprocessable_entity }
      end
    end
  end

  # PUT /dashboards/1
  # PUT /dashboards/1.json
  def update
    @dashboard = Dashboard.find(params[:id])

    respond_to do |format|
      if @dashboard.update_attributes(params[:dashboard])
        format.html { redirect_to @dashboard, notice: 'Dashboard was successfully updated.' }
        format.json { head :no_content }
      else
        format.html { render action: "edit" }
        format.json { render json: @dashboard.errors, status: :unprocessable_entity }
      end
    end
  end

  # DELETE /dashboards/1
  # DELETE /dashboards/1.json
  def destroy
    @dashboard = Dashboard.find(params[:id])
    @dashboard.destroy
		set_an_active_dashboard
    respond_to do |format|
      format.html { redirect_to dashboards_url }
      format.json { render	json: @active_dashboard }
    end
  end
end
