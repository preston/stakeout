require 'test_helper'

class WelcomeControllerTest < ActionController::TestCase
  test "should get status" do
    get :status, as: :json
    assert_response :success
  end
end
