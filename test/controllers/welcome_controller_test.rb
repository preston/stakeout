require 'test_helper'

class WelcomeControllerTest < ActionController::TestCase
  test "should get legal" do
    get :legal
    assert_response :success
  end

  test "should get about" do
    get :about
    assert_response :success
  end

end
