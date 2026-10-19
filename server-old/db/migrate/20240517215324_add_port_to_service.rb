class AddPortToService < ActiveRecord::Migration[7.1]
  def change
    add_column :services, :port, :integer, null: false, default: 0
  end
end
