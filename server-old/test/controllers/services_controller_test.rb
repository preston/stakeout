require 'test_helper'

class ServicesControllerTest < ActionController::TestCase
  setup do
    @dashboard = dashboards(:one)
    @service = services(:one)
    @request.env["HTTP_AUTHORIZATION"] = ActionController::HttpAuthentication::Basic.encode_credentials(
      ENV["STAKEOUT_SERVER_USERNAME"], ENV["STAKEOUT_SERVER_PASSWORD"]
    )
  end

  test "should get index" do
    get :index, params: { dashboard_id: @dashboard }, as: :json
    assert_response :success
    assert_not_nil assigns(:services)
  end

  test "should show service" do
    get :show, params: { dashboard_id: @dashboard, id: @service }, as: :json
    assert_response :success
  end

  test "should create service" do
    assert_difference('Service.count') do
      post :create, params: {
        dashboard_id: @dashboard,
        service: { name: "New Service", host: "host.example.com", dashboard_id: @dashboard.id }
      }, as: :json
    end
    assert_response :created
  end

  test "should update service" do
    patch :update, params: {
      dashboard_id: @dashboard,
      id: @service,
      service: { name: @service.name, host: @service.host }
    }, as: :json
    assert_response :success
  end

  test "should destroy service" do
    assert_difference('Service.count', -1) do
      delete :destroy, params: { dashboard_id: @dashboard, id: @service }, as: :json
    end
    assert_response :success
  end
end
