class CreateDashboards < ActiveRecord::Migration
  def change
    create_table :dashboards do |t|
      t.string :name

      t.timestamps
    end
    add_index :dashboards, :name, :unique => true
  end
end
