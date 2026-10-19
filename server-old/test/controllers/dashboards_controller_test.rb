require 'test_helper'

class DashboardsControllerTest < ActionController::TestCase
  setup do
    @dashboard = dashboards(:one)
    @request.env["HTTP_AUTHORIZATION"] = ActionController::HttpAuthentication::Basic.encode_credentials(
      ENV["STAKEOUT_SERVER_USERNAME"], ENV["STAKEOUT_SERVER_PASSWORD"]
    )
  end

  test "should get index" do
    get :index, as: :json
    assert_response :success
    assert_not_nil assigns(:dashboards)
  end

  test "should show dashboard" do
    get :show, params: { id: @dashboard }, as: :json
    assert_response :success
  end

  test "should create dashboard" do
    assert_difference('Dashboard.count') do
      post :create, params: { dashboard: { name: @dashboard.name + " Copy" } }, as: :json
    end
    assert_response :created
  end

  test "should update dashboard" do
    patch :update, params: { id: @dashboard, dashboard: { name: @dashboard.name } }, as: :json
    assert_response :success
  end

  test "should destroy dashboard" do
    assert_difference('Dashboard.count', -1) do
      delete :destroy, params: { id: @dashboard }, as: :json
    end
    assert_response :success
  end
end
