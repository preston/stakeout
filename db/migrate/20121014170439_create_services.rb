class CreateServices < ActiveRecord::Migration
  def change
    create_table :services do |t|
      t.integer :dashboard_id
      t.string :name,	:null => false
      t.string :host,	:null => false
      t.boolean :ping,	:default => true
			t.integer	:ping_threshold,	:default => 500
			t.integer	:ping_last
      t.boolean :http,	:default => true
      t.boolean :https,	:default => false
      t.string	:http_path,	:null => false,	:default => ''
      t.boolean :http_path_last,  :default => false
      t.boolean :https_path_last,  :default => false
      t.string	:http_xquery
			t.boolean	:http_xquery_last,	:default => false
			t.boolean	:http_preview,	:default => true
      t.binary  :http_screenshot, limit: (1024 * 1024) # 1MiB. Yeah yeah whatever.
			t.datetime	:checked_at
      t.timestamps
    end
  end
end
