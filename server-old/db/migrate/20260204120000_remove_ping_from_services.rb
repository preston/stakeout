# Author: Preston Lee

class RemovePingFromServices < ActiveRecord::Migration[8.1]
  def change
    remove_column :services, :ping, :boolean
    remove_column :services, :ping_last, :integer
    remove_column :services, :ping_threshold, :integer
  end
end
