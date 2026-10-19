# frozen_string_literal: true

class WelcomeController < ApplicationController
  before_action :http_authenticate, only: %i[test]

  def status
  end

  def test
  end

end
