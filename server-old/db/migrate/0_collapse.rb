class Collapse < ActiveRecord::Migration[7.0]

  enable_extension "plpgsql"
  enable_extension "uuid-ossp"
  
  create_table "dashboards", id: :uuid do |t|
    t.string   "name"
    t.timestamps
  end

  add_index "dashboards", ["name"], name: "index_dashboards_on_name", unique: true

  create_table "services", id: :uuid do |t|
    t.belongs_to  :dashboard, foreign_key: true, type: :uuid
    t.string   "name",                                             null: false
    t.string   "host",                                             null: false
    t.boolean  "ping",                             default: true
    t.integer  "ping_threshold",                   default: 500
    t.integer  "ping_last"
    t.boolean  "http",                             default: true
    t.boolean  "https",                            default: false
    t.string   "http_path",                        default: "",    null: false
    t.boolean  "http_path_last",                   default: false
    t.boolean  "https_path_last",                  default: false
    t.string   "http_xquery"
    t.boolean  "http_xquery_last",                 default: false
    t.boolean  "http_preview",                     default: true
    t.binary   "http_screenshot",  limit: 1024 * 1024 * 10 #10MiB
    t.datetime "checked_at"
    t.timestamps
    t.index [:dashboard_id, :name], unique: true
  end

end
